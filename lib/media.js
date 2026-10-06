'use strict';

// File types a browser can usually play (or that are worth trying).
const MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|ogv|ogg|mov|m3u8|mp3|m4a|aac|wav|flac|opus)$/i;

/**
 * Turns a pasted link into a media descriptor the players understand.
 * Platform links are never downloaded: the browser plays them from the platform itself.
 * Returns { error } when the link can't be used.
 */
function parseMediaUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return { error: "That doesn't look like a valid link." };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http(s) links are supported.' };
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m|music|mobile)\./, '');

  // YouTube
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v');
    if (!id) {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
    if (!id || !/^[\w-]{11}$/.test(id)) {
      return { error: "Couldn't find a video in that YouTube link." };
    }
    return {
      kind: 'youtube',
      videoId: id,
      src: `https://www.youtube.com/watch?v=${id}`,
      title: 'YouTube video',
      titleFromClient: true,
    };
  }

  // Facebook (the embedded player wants the canonical www URL)
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch') {
    if (host !== 'fb.watch') url.hostname = 'www.facebook.com';
    return { kind: 'facebook', src: url.href, title: 'Facebook video' };
  }

  // Vimeo
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = url.pathname.match(/(?:^|\/)(\d{4,})(?:\/([\da-f]+))?/i);
    if (!m) return { error: "Couldn't find a video in that Vimeo link." };
    const src = `https://vimeo.com/${m[1]}${m[2] ? '/' + m[2] : ''}`;
    return { kind: 'vimeo', src, title: 'Vimeo video', titleFromClient: true };
  }

  // Twitch: past broadcasts (seekable, synced) and live channels
  if (host === 'twitch.tv') {
    const vod = url.pathname.match(/^\/videos\/(\d+)/);
    if (vod) {
      return { kind: 'twitch', videoId: vod[1], src: url.href, title: `Twitch video ${vod[1]}` };
    }
    const channel = url.pathname.match(/^\/([a-z0-9_]{3,25})\/?$/i);
    if (channel) {
      return { kind: 'twitch', channel: channel[1], live: true, src: url.href, title: `${channel[1]} (live on Twitch)` };
    }
    return { error: 'Use a Twitch channel link or a link to a past broadcast (twitch.tv/videos/…).' };
  }

  // Anything else is treated as a direct video file / HLS stream link.
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  return {
    kind: 'direct',
    src: url.href,
    title: last || url.hostname,
    hls: /\.m3u8$/i.test(url.pathname),
  };
}

module.exports = { parseMediaUrl, MEDIA_EXTENSIONS };
