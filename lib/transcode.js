'use strict';

/*
 * Smooth mode: makes lower-quality copies of an uploaded video, cut into 4-second segments,
 * so each viewer's player can pick the quality their connection keeps up with (HLS).
 *
 * FFmpeg only writes the segment files. The server builds the playlists itself (see
 * server.js), listing the whole video up front, because every segment is exactly
 * SEGMENT_SECONDS long. That way viewers can start using smooth mode seconds after an upload,
 * while encoding (several times faster than playback) continues ahead of them. It also means
 * FFmpeg never has to replace a playlist file that a viewer is reading, which fails on Windows.
 *
 * Needs FFmpeg. Without it, uploads still play in their original quality.
 */

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SEGMENT_SECONDS = 4;
// Height -> target video bitrate (kbit/s). Only qualities below the source's height are made.
const LADDER = [
  { height: 1080, kbps: 5000 },
  { height: 720, kbps: 2800 },
  { height: 480, kbps: 1400 },
  { height: 360, kbps: 800 },
];
const AUDIO_KBPS = 128;

// On Windows, `winget install Gyan.FFmpeg` puts FFmpeg here; terminals opened before the
// install don't have it on their PATH yet.
function wingetBinary(name) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const root = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(root).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const sub of fs.readdirSync(path.join(root, pkg))) {
        const bin = path.join(root, pkg, sub, 'bin', `${name}.exe`);
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return null;
}

function findBinary(name, envVar) {
  const candidates = [process.env[envVar], name, wingetBinary(name)].filter(Boolean);
  for (const bin of candidates) {
    try {
      if (spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10000 }).status === 0) return bin;
    } catch {}
  }
  return null;
}

const FFMPEG = findBinary('ffmpeg', 'FFMPEG_PATH');
const FFPROBE = FFMPEG ? findBinary('ffprobe', 'FFPROBE_PATH') : null;
const available = !!(FFMPEG && FFPROBE);

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('Could not read the video file.');
  const info = JSON.parse(r.stdout);
  const video = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  return { duration: Number(info.format?.duration) || 0, video, hasAudio: !!audio };
}

/** Plans the qualities to make for this source. */
function plan(src) {
  const height = Number(src.video.height) || 720;
  const width = Number(src.video.width) || Math.round((height * 16) / 9);
  // Browsers play 8-bit H.264 directly, so viewers on good connections keep the original and
  // only lower qualities are needed. Anything else (HEVC, 10-bit, VP9…) is also made in a
  // top quality, because many browsers can't play the original at all.
  const originalPlayable = src.video.codec_name === 'h264' && /^(yuv420p|yuvj420p)$/.test(src.video.pix_fmt || '');
  const heights = [];
  if (!originalPlayable) heights.push(Math.min(height, 1080));
  for (const step of LADDER) if (step.height < height - 40 && !heights.includes(step.height)) heights.push(step.height);
  if (!heights.length) heights.push(Math.min(height, 360)); // tiny source: one small copy
  return heights.map((h) => {
    const kbps = (LADDER.find((s) => s.height <= h) || LADDER.at(-1)).kbps;
    return {
      name: `${h}p`,
      height: h,
      width: Math.round((width * h) / height / 2) * 2,
      kbps,
      bandwidth: Math.round((kbps * 1.1 + AUDIO_KBPS) * 1000),
    };
  });
}

/**
 * Starts encoding `input` into `outDir`/<quality>/s00000.ts, s00001.ts, …
 * Returns { info, promise, cancel }: info = { duration, segments, variants } describes the
 * output (known before encoding starts). onProgress({ fraction, seconds }) reports progress.
 */
function encodeHls(input, outDir, onProgress) {
  const src = probe(input);
  if (!src.video) throw new Error('The file has no video track.');
  if (!src.duration) throw new Error('Could not read the length of the video.');
  const variants = plan(src);
  const info = { duration: src.duration, segments: Math.ceil(src.duration / SEGMENT_SECONDS), variants };

  fs.mkdirSync(outDir, { recursive: true });
  const split = variants.length > 1 ? `[0:v]split=${variants.length}${variants.map((_, i) => `[s${i}]`).join('')};` : '';
  const filters = variants.map((v, i) => `${variants.length > 1 ? `[s${i}]` : '[0:v]'}scale=-2:${v.height}[e${i}]`).join(';');

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-filter_complex', split + filters];
  variants.forEach((v, i) => {
    args.push('-map', `[e${i}]`, `-b:v:${i}`, `${v.kbps}k`, `-maxrate:v:${i}`, `${Math.round(v.kbps * 1.1)}k`, `-bufsize:v:${i}`, `${v.kbps * 2}k`);
    if (src.hasAudio) args.push('-map', '0:a:0');
  });
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    // A keyframe every 2 s: segments are then exactly SEGMENT_SECONDS long, and a player can
    // switch quality at any segment.
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
    '-threads', String(Math.max(1, os.cpus().length - 2)),
  );
  if (src.hasAudio) args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2');
  // Forward slashes even on Windows, so paths are valid in every tool.
  const out = outDir.replace(/\\/g, '/');
  args.push(
    // "vod" makes FFmpeg write its own playlists in place (we don't use them) instead of
    // through temporary files that get renamed.
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
    '-hls_segment_filename', `${out}/%v/s%05d.ts`,
    '-var_stream_map', variants.map((v, i) => `v:${i}${src.hasAudio ? `,a:${i}` : ''},name:${v.name}`).join(' '),
    '-progress', 'pipe:1', '-nostats',
    `${out}/%v/ffmpeg.m3u8`,
  );
  if (process.env.TRANSCODE_DEBUG) {
    args[args.indexOf('error')] = 'warning';
    console.log('[transcode]', FFMPEG, args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  }

  let child = null;
  let cancelled = false;
  const promise = new Promise((resolve, reject) => {
    child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Encoding is background work: keep the server and viewers' streams responsive.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let stderr = '';
    let lastReported = -1;
    child.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (!m) return;
      const seconds = Number(m[m.length - 1].split('=')[1]) / 1e6;
      const fraction = Math.min(0.99, seconds / src.duration);
      if (fraction - lastReported >= 0.01) {
        lastReported = fraction;
        onProgress?.({ fraction, seconds });
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').pop()}`));
    });
  });
  return {
    info,
    promise,
    cancel() {
      cancelled = true;
      child?.kill();
    },
  };
}

/** The master playlist: one entry per quality. */
function masterPlaylist(info) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const v of info.variants) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height},CODECS="avc1.640028,mp4a.40.2"`, `${v.name}/index.m3u8`);
  }
  return lines.join('\n') + '\n';
}

/** A quality's playlist, listing every segment of the whole video, even ones still being encoded. */
function variantPlaylist(info) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < info.segments; i++) {
    const len = i < info.segments - 1 ? SEGMENT_SECONDS : info.duration - SEGMENT_SECONDS * (info.segments - 1);
    lines.push(`#EXTINF:${len.toFixed(3)},`, `s${String(i).padStart(5, '0')}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

module.exports = { available, encodeHls, masterPlaylist, variantPlaylist, SEGMENT_SECONDS };
