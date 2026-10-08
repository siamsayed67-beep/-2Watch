'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { parseMediaUrl, MEDIA_EXTENSIONS } = require('./lib/media');
const transcode = require('./lib/transcode');

// Supabase accounts are optional: without credentials, people join with just a name.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const authEnabled = !!supabase;

/** Returns { id, name } for a valid Supabase access token, or null. */
async function verifyToken(token) {
  if (!authEnabled || typeof token !== 'string' || !token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    const u = data.user;
    return { id: u.id, name: u.user_metadata?.username || u.email?.split('@')[0] || 'Guest' };
  } catch {
    return null;
  }
}

const bearer = (req) => req.get('authorization')?.replace(/^Bearer\s+/i, '');

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 16384;
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024; // uploads are sent in pieces of this size
const UPLOAD_IDLE_MS = 30 * 60 * 1000; // an upload with no new piece for this long is discarded
const ROOM_IDLE_MINUTES = Number(process.env.ROOM_IDLE_MINUTES) || 30;
const START_DELAY_MS = 1500; // every new video starts this long after it's loaded, so all viewers start together
const HOST_GRACE_MS = 20000; // a host who refreshes the page keeps the host role
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Rooms live in memory, so uploads left over from a previous run belong to nobody.
// Clear the contents rather than the folder itself: on Windows the folder can't be removed
// while it's open somewhere (e.g. in File Explorer), and that shouldn't stop the server.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const entry of fs.readdirSync(UPLOAD_DIR)) {
  try {
    fs.rmSync(path.join(UPLOAD_DIR, entry), { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`Could not remove old upload ${entry}: ${err.code}`);
  }
}

const app = express();
const server = http.createServer(app);
// Node cuts off any request after 5 minutes by default. Upload pieces are small, but on a
// very slow connection one piece can take longer than that.
server.requestTimeout = 15 * 60 * 1000;
const io = new Server(server);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

/* ------------------------------------------------------------------ rooms */

const rooms = new Map();

const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomId(len) {
  let s = '';
  for (const b of crypto.randomBytes(len)) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

function clean(value, max, fallback = '') {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  return s || fallback;
}

function createRoom(name, existingId) {
  let id = existingId;
  while (!id || rooms.has(id)) id = randomId(6);
  const room = {
    id,
    name,
    hostId: null,
    hostTimer: null,
    everyoneCanControl: true,
    members: new Map(), // socket.id -> { clientId, name }
    media: null,
    queue: [],
    // The room's master clock: at server time `updatedAt` the video was at `position` seconds.
    playback: { playing: false, position: 0, updatedAt: Date.now() },
    chat: [],
    files: new Set(),
    emptySince: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function destroyRoom(room) {
  clearTimeout(room.hostTimer);
  for (const file of room.files) removeUploadFiles(file);
  for (const up of pendingUploads.values()) if (up.roomId === room.id) discardUpload(up);
  rooms.delete(room.id);
}

function getPosition(room, clamp = true) {
  const p = room.playback;
  let pos = p.playing ? p.position + (Date.now() - p.updatedAt) / 1000 : p.position;
  if (!clamp) return pos;
  pos = Math.max(0, pos);
  if (room.media?.duration) pos = Math.min(pos, room.media.duration);
  return pos;
}

function playbackPayload(room) {
  return { ...room.playback, mediaId: room.media?.id ?? null, serverNow: Date.now() };
}

function setPlayback(room, playing, position) {
  room.playback = { playing, position: Math.max(0, position), updatedAt: Date.now() };
  io.to(room.id).emit('playback', playbackPayload(room));
}

function publicState(room) {
  const users = new Map();
  for (const m of room.members.values()) {
    if (!users.has(m.clientId)) users.set(m.clientId, { id: m.clientId, name: m.name, voice: null });
    // Voice status per person (a person may have several tabs): 'on', 'muted' or 'nomic'.
    if (m.voice) {
      const u = users.get(m.clientId);
      const v = !m.voice.hasMic ? 'nomic' : m.voice.muted ? 'muted' : 'on';
      if (!u.voice || v === 'on' || (v === 'muted' && u.voice === 'nomic')) u.voice = v;
    }
  }
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    everyoneCanControl: room.everyoneCanControl,
    media: room.media,
    queue: room.queue,
    users: [...users.values()],
    playback: playbackPayload(room),
  };
}

const broadcastState = (room) => io.to(room.id).emit('room:state', publicState(room));

function addChat(room, msg) {
  const m = { id: randomId(8), at: Date.now(), ...msg };
  room.chat.push(m);
  if (room.chat.length > 200) room.chat.shift();
  io.to(room.id).emit('chat:message', m);
}
const announce = (room, text) => addChat(room, { system: true, text });

function deleteFileIfUnused(room, item) {
  if (item?.kind !== 'file') return;
  if (room.media?.id === item.id || room.queue.some((q) => q.id === item.id)) return;
  removeUploadFiles(item.file);
  room.files.delete(item.file);
}

/* ------------------------------------------------- adaptive (smooth) playback */

/*
 * After an upload, FFmpeg makes lower-quality copies cut into 4-second segments (HLS).
 * Viewers whose connection can't keep up with the original switch to these, and their
 * player picks the best quality their connection can sustain. One video is encoded at a
 * time, the one that's playing first.
 */
const encodeQueue = []; // { roomId, item }
let encoding = null; // { roomId, item, job }

const hlsDirName = (file) => path.parse(file).name + '_hls';

function removeUploadFiles(file) {
  cancelEncode(file);
  hlsOutputs.delete(hlsDirName(file));
  fs.unlink(path.join(UPLOAD_DIR, file), () => {});
  fs.rm(path.join(UPLOAD_DIR, hlsDirName(file)), { recursive: true, force: true }, () => {});
}

function cancelEncode(file) {
  const i = encodeQueue.findIndex((j) => j.item.file === file);
  if (i >= 0) encodeQueue.splice(i, 1);
  if (encoding?.item.file === file) encoding.job.cancel();
}

function queueEncode(room, item) {
  if (!transcode.available) return;
  item.adaptive = { status: 'queued' };
  encodeQueue.push({ roomId: room.id, item });
  pumpEncodes();
}

function pumpEncodes() {
  if (encoding || !encodeQueue.length) return;
  let i = encodeQueue.findIndex((j) => rooms.get(j.roomId)?.media?.id === j.item.id);
  if (i < 0) i = 0;
  const [{ roomId, item }] = encodeQueue.splice(i, 1);
  const room = rooms.get(roomId);
  if (!room) return pumpEncodes();

  const dir = hlsDirName(item.file);
  let job;
  try {
    job = transcode.encodeHls(path.join(UPLOAD_DIR, item.file), path.join(UPLOAD_DIR, dir), ({ fraction, seconds }) => {
      item.adaptive.progress = fraction;
      item.adaptive.encodedUntil = seconds;
      hls.encodedUntil = seconds;
      // Viewers can switch once the first few segments exist; encoding stays ahead of playback.
      const becamePlayable = !item.adaptiveSrc && seconds >= transcode.SEGMENT_SECONDS * 3;
      if (becamePlayable) item.adaptiveSrc = `/media/${dir}/master.m3u8`;
      if ((becamePlayable || fraction - lastSent >= 0.05) && rooms.has(roomId)) {
        lastSent = fraction;
        broadcastState(room);
      }
    });
  } catch (err) {
    console.error(`Could not prepare smooth playback for "${item.title}":`, err.message);
    item.adaptive = { status: 'failed' };
    broadcastState(room);
    return pumpEncodes();
  }
  const hls = { info: job.info, done: false, encodedUntil: 0 };
  hlsOutputs.set(dir, hls);
  item.adaptive = { status: 'encoding', progress: 0, qualities: job.info.variants.map((v) => v.name) };
  broadcastState(room);
  let lastSent = 0;
  encoding = { roomId, item, job };
  job.promise
    .then(() => {
      hls.done = true;
      item.adaptive = { status: 'ready', qualities: job.info.variants.map((v) => v.name) };
      item.adaptiveSrc = `/media/${dir}/master.m3u8`;
    })
    .catch((err) => {
      hlsOutputs.delete(dir);
      if (err.message === 'cancelled') return;
      delete item.adaptiveSrc;
      console.error(`Could not prepare smooth playback for "${item.title}":`, err.message);
      item.adaptive = { status: 'failed' };
    })
    .finally(() => {
      encoding = null;
      if (rooms.has(roomId)) broadcastState(room);
      pumpEncodes();
    });
}

// Smooth-mode files. The playlists are generated here (see lib/transcode.js), and a segment
// that's still being encoded is held back until it's complete.
const hlsOutputs = new Map(); // folder name -> { info, done, encodedUntil }
const HLS_DIR = '[0-9a-f]{32}_hls';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get(new RegExp(`^/media/(${HLS_DIR})/master\\.m3u8$`), (req, res) => {
  const hls = hlsOutputs.get(req.params[0]);
  if (!hls) return res.sendStatus(404);
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-cache').send(transcode.masterPlaylist(hls.info));
});

app.get(new RegExp(`^/media/(${HLS_DIR})/(\\d{3,4}p)/index\\.m3u8$`), (req, res) => {
  const hls = hlsOutputs.get(req.params[0]);
  if (!hls || !hls.info.variants.some((v) => v.name === req.params[1])) return res.sendStatus(404);
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-cache').send(transcode.variantPlaylist(hls.info));
});

app.get(new RegExp(`^/media/(${HLS_DIR})/(\\d{3,4}p)/s(\\d{5})\\.ts$`), async (req, res) => {
  const { 0: dir, 1: quality, 2: num } = req.params;
  const hls = hlsOutputs.get(dir);
  if (!hls || !hls.info.variants.some((v) => v.name === quality)) return res.sendStatus(404);
  const index = Number(num);
  if (index >= hls.info.segments) return res.sendStatus(404);
  const file = path.join(UPLOAD_DIR, dir, quality, `s${num}.ts`);
  // A segment is complete once FFmpeg has started the next one (or finished everything).
  const next = path.join(UPLOAD_DIR, dir, quality, `s${String(index + 1).padStart(5, '0')}.ts`);
  const ready = () => hls.done || fs.existsSync(next);
  for (let waited = 0; !ready(); waited += 250) {
    if (waited >= 15000 || !hlsOutputs.has(dir) || req.socket.destroyed) {
      return res.status(503).set('Retry-After', '2').send('Not encoded yet');
    }
    await sleep(250);
  }
  res.type('video/mp2t').set('Cache-Control', 'public, max-age=86400').sendFile(file, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Original uploaded videos. express.static supports HTTP range requests, so viewers can seek
// and start mid-file without downloading everything first. (Registered after the smooth-mode
// routes above, so those take priority.)
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '1d', fallthrough: false }));

function loadMedia(room, item) {
  const previous = room.media;
  room.media = item;
  // Scheduled slightly in the future so every viewer has loaded the video when it starts.
  room.playback = { playing: true, position: 0, updatedAt: Date.now() + START_DELAY_MS };
  deleteFileIfUnused(room, previous);
  broadcastState(room);
}

function advance(room) {
  const next = room.queue.shift();
  if (next) {
    loadMedia(room, next);
    announce(room, `Now playing: ${next.title}`);
  } else {
    setPlayback(room, false, room.media?.duration ?? getPosition(room));
  }
}

function playNowOrQueue(room, item, mode, byName) {
  // Platform titles are only known once a player loads them, so don't announce the placeholder.
  const label = item.titleFromClient ? `a ${item.title}` : `"${item.title}"`;
  if (mode === 'queue' && room.media) {
    room.queue.push(item);
    broadcastState(room);
    announce(room, `${byName} added ${label} to the queue`);
  } else {
    loadMedia(room, item);
    announce(room, `${byName} started ${label}`);
  }
}

function memberName(room, clientId) {
  for (const m of room.members.values()) if (m.clientId === clientId) return m.name;
  return null;
}

const canControl = (room, clientId) => room.everyoneCanControl || clientId === room.hostId;

function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* -------------------------------------------------------------- HTTP API */

// The browser needs these to talk to Supabase. The anon key is meant to be public;
// what users can do with it is limited by Supabase's own rules.
// Voice chat connects browsers directly. STUN servers let them find a route through home
// routers; a TURN server (optional, set in .env) relays audio for the few networks where a
// direct connection isn't possible.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

app.get('/api/config', (req, res) => {
  res.json({
    ...(authEnabled ? { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } : {}),
    iceServers: ICE_SERVERS,
  });
});

app.post('/api/rooms', async (req, res) => {
  if (authEnabled && !(await verifyToken(bearer(req)))) {
    return res.status(401).json({ error: 'Sign in to create a room.' });
  }
  const room = createRoom(clean(req.body?.name, 60, 'Watch party'));
  res.json({ id: room.id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({ id: room.id, name: room.name, maxUploadMb: MAX_UPLOAD_MB });
});

function safeExt(name) {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/*
 * Chunked, resumable uploads. A video is sent as a series of small pieces instead of one
 * huge request, so a long upload isn't cut off by request time limits (Node's own is
 * 5 minutes) or proxy size limits, and a dropped connection only costs one piece, which
 * the browser retries. The upload id acts as the uploader's key for the later pieces.
 */
const pendingUploads = new Map(); // uploadId -> { id, roomId, clientId, name, title, size, file, path, received, busy, lastActivity }

function discardUpload(up) {
  pendingUploads.delete(up.id);
  fs.unlink(up.path, () => {});
}

async function freeDiskBytes() {
  try {
    const st = await fs.promises.statfs(UPLOAD_DIR);
    return st.bavail * st.bsize;
  } catch {
    return Infinity; // can't tell; let the write fail later if the disk really is full
  }
}

app.post('/api/rooms/:id/uploads', async (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  let clientId = req.get('x-client-id');
  if (authEnabled) {
    const user = await verifyToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'Your sign-in expired. Refresh the page and try again.' });
    clientId = user.id;
  }
  const name = memberName(room, clientId);
  if (!name) return res.status(403).json({ error: 'Join the room before uploading.' });
  if (!canControl(room, clientId)) return res.status(403).json({ error: 'Only the host can add videos in this room.' });

  const fileName = clean(req.body?.name, 200);
  const type = String(req.body?.type ?? '');
  const size = Number(req.body?.size);
  if (!fileName || !(/^(video|audio)\//.test(type) || MEDIA_EXTENSIONS.test(fileName))) {
    return res.status(415).json({ error: 'Only video or audio files can be uploaded.' });
  }
  if (!Number.isSafeInteger(size) || size <= 0) return res.status(400).json({ error: 'That file is empty.' });
  if (size > MAX_UPLOAD_MB * 1024 * 1024) {
    return res.status(413).json({ error: `That file is too large (max ${MAX_UPLOAD_MB} MB).` });
  }
  // Leave room for uploads already in progress, plus a safety margin.
  // The smooth-playback copies take roughly twice the original's size again.
  const needed = transcode.available ? size * 3 : size;
  let reserved = 512 * 1024 * 1024;
  for (const up of pendingUploads.values()) reserved += up.size - up.received;
  if (needed + reserved > (await freeDiskBytes())) {
    return res.status(507).json({ error: 'There is not enough free space on the server for this file.' });
  }

  const file = crypto.randomBytes(16).toString('hex') + safeExt(fileName);
  const up = {
    id: crypto.randomBytes(16).toString('hex'),
    roomId: room.id,
    clientId,
    name,
    title: clean(fileName, 120, 'Uploaded video'),
    size,
    file,
    path: path.join(UPLOAD_DIR, file),
    received: 0,
    busy: false,
    lastActivity: Date.now(),
  };
  await fs.promises.writeFile(up.path, '');
  pendingUploads.set(up.id, up);
  res.json({ uploadId: up.id, chunkSize: UPLOAD_CHUNK_BYTES });
});

const missingUpload = (res) =>
  res.status(404).json({ error: 'This upload expired or was cancelled. Please upload the file again.' });

app.put(
  '/api/uploads/:uploadId',
  express.raw({ type: 'application/octet-stream', limit: UPLOAD_CHUNK_BYTES + 1024 }),
  async (req, res) => {
    const up = pendingUploads.get(req.params.uploadId);
    if (!up) return missingUpload(res);
    const offset = Number(req.query.offset);
    // A retried piece the server already has, or a piece out of order: tell the browser
    // where to continue from instead of failing.
    if (up.busy || offset !== up.received) return res.status(409).json({ received: up.received });
    const chunk = req.body;
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 || offset + chunk.length > up.size) {
      return res.status(400).json({ error: 'Received an invalid piece of the file.' });
    }
    up.busy = true;
    try {
      await fs.promises.appendFile(up.path, chunk);
      up.received += chunk.length;
      up.lastActivity = Date.now();
      res.json({ received: up.received });
    } catch (err) {
      // Undo a partly written piece so the next retry starts from a clean point.
      await fs.promises.truncate(up.path, up.received).catch(() => {});
      const full = err.code === 'ENOSPC';
      res.status(full ? 507 : 500).json({ error: full ? 'The server ran out of disk space.' : 'Could not save part of the file.' });
    } finally {
      up.busy = false;
    }
  },
);

app.post('/api/uploads/:uploadId/complete', (req, res) => {
  const up = pendingUploads.get(req.params.uploadId);
  if (!up) return missingUpload(res);
  if (up.busy || up.received !== up.size) {
    return res.status(409).json({ error: 'The upload is not finished yet.', received: up.received });
  }
  const room = rooms.get(up.roomId);
  if (!room) {
    discardUpload(up);
    return res.status(410).json({ error: 'The room has closed.' });
  }
  if (!canControl(room, up.clientId)) {
    discardUpload(up);
    return res.status(403).json({ error: 'Only the host can add videos in this room.' });
  }
  pendingUploads.delete(up.id);
  room.files.add(up.file);
  const item = { id: randomId(10), kind: 'file', file: up.file, src: `/media/${up.file}`, title: up.title, duration: null, addedBy: up.name };
  playNowOrQueue(room, item, req.body?.mode, up.name);
  queueEncode(room, item);
  res.json({ ok: true });
});

app.delete('/api/uploads/:uploadId', (req, res) => {
  const up = pendingUploads.get(req.params.uploadId);
  if (up) discardUpload(up);
  res.json({ ok: true });
});

/* ------------------------------------------------------------- realtime */

function leaveRoom(socket) {
  const room = rooms.get(socket.data.roomId);
  socket.data.roomId = null;
  if (!room) return;
  socket.leave(room.id);
  const me = room.members.get(socket.id);
  room.members.delete(socket.id);
  if (!me) return;
  if (me.voice) socket.to(room.id).emit('voice:peer-left', { id: socket.id });

  const stillHere = [...room.members.values()].some((m) => m.clientId === me.clientId);
  if (!stillHere) announce(room, `${me.name} left`);
  if (room.members.size === 0) room.emptySince = Date.now();

  if (me.clientId === room.hostId && !stillHere) scheduleHostHandover(room);
  broadcastState(room);
}

// If the host doesn't come back within the grace period, someone else present becomes host.
function scheduleHostHandover(room) {
  clearTimeout(room.hostTimer);
  room.hostTimer = setTimeout(() => {
    if (!rooms.has(room.id)) return;
    const present = [...room.members.values()];
    if (present.some((m) => m.clientId === room.hostId)) return;
    const next = present[0];
    room.hostId = next?.clientId ?? null;
    if (next) announce(room, `${next.name} is now the host`);
    broadcastState(room);
  }, HOST_GRACE_MS);
}

/*
 * Rooms live in memory, so a server restart (a crash, a redeploy, or the host restarting
 * the service) loses them. Every viewer's browser keeps a copy of its room, and the first
 * one to reconnect recreates it from that copy, so the party carries on where it was.
 * Video links are re-checked rather than trusted. Uploaded files were stored by the old
 * server process and are gone, so they're left out and the room is told.
 */
function restoreRoom(id, snap, restoredBy) {
  const room = createRoom(clean(snap?.name, 60, 'Watch party'), id);
  room.everyoneCanControl = snap?.everyoneCanControl !== false;
  let lostUploads = 0;
  const restoreItem = (it) => {
    if (!it || typeof it !== 'object') return null;
    if (it.kind === 'file') {
      lostUploads++;
      return null;
    }
    const parsed = parseMediaUrl(String(it.src ?? ''));
    if (parsed.error) return null;
    const duration = Number(it.duration);
    return {
      id: randomId(10),
      ...parsed,
      title: clean(it.title, 120, parsed.title),
      titleFromClient: false,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      addedBy: clean(it.addedBy, 32, 'Someone'),
    };
  };
  room.media = restoreItem(snap?.media);
  room.queue = (Array.isArray(snap?.queue) ? snap.queue.slice(0, 200) : []).map(restoreItem).filter(Boolean);
  if (room.media) {
    let pos = Math.max(0, Number(snap?.playback?.position) || 0);
    if (room.media.duration) pos = Math.min(pos, room.media.duration);
    room.playback = { playing: !!snap?.playback?.playing, position: pos, updatedAt: Date.now() + START_DELAY_MS };
  }
  // The previous host keeps the role if they come back; otherwise it's handed on as usual.
  room.hostId = clean(snap?.hostId, 64) || null;
  if (room.hostId) scheduleHostHandover(room);
  announce(
    room,
    `The server restarted, so ${restoredBy} restored this room.` +
      (lostUploads ? ' Uploaded videos were lost in the restart and need to be uploaded again.' : ''),
  );
  return room;
}

io.on('connection', (socket) => {
  // Registers a room event. `fn` returns a result for the ack, or nothing for { ok: true }.
  function on(event, { control = false } = {}, fn) {
    socket.on(event, (...args) => {
      const cb = typeof args.at(-1) === 'function' ? args.pop() : () => {};
      const room = rooms.get(socket.data.roomId);
      if (!room) return cb({ ok: false, error: 'You are not in a room.' });
      const clientId = socket.data.clientId;
      if (control && !canControl(room, clientId)) {
        return cb({ ok: false, error: 'Only the host can control playback in this room.' });
      }
      const name = room.members.get(socket.id)?.name ?? 'Someone';
      try {
        cb(fn(room, { clientId, name }, args[0] ?? {}) ?? { ok: true });
      } catch (e) {
        console.error(e);
        cb({ ok: false, error: 'Something went wrong.' });
      }
    });
  }

  // Clients measure their clock offset against this to compute where "now" is in the video.
  socket.on('time:ping', (cb) => typeof cb === 'function' && cb(Date.now()));

  // Recreates a room lost in a server restart from a viewer's copy (see restoreRoom).
  socket.on('room:restore', async (data, cb) => {
    if (typeof cb !== 'function') return;
    const roomId = String(data?.roomId ?? '');
    if (!/^[a-z0-9]{4,16}$/.test(roomId)) return cb({ ok: false, error: 'Invalid room code.' });
    let name = clean(data?.name, 32, 'Someone');
    if (authEnabled) {
      const user = await verifyToken(data?.token);
      if (!user) return cb({ ok: false, error: 'Please sign in to join this room.', needsAuth: true });
      name = clean(user.name, 32, 'Someone');
    }
    // Another viewer may have restored it a moment ago; then there's nothing to do.
    if (!rooms.has(roomId)) restoreRoom(roomId, data?.snapshot, name);
    cb({ ok: true });
  });

  socket.on('room:join', async (data, cb) => {
    if (typeof cb !== 'function') return;
    let clientId = clean(data?.clientId, 64);
    let name = clean(data?.name, 32, 'Guest');
    if (authEnabled) {
      // Signed-in users are identified by their Supabase account, so the host role
      // follows the account across devices and the name can't be faked.
      const user = await verifyToken(data?.token);
      if (!user) return cb({ ok: false, error: 'Please sign in to join this room.', needsAuth: true });
      clientId = user.id;
      name = clean(user.name, 32, 'Guest');
    }
    const room = rooms.get(String(data?.roomId ?? ''));
    if (!room) return cb({ ok: false, notFound: true, error: 'This room does not exist or has closed.' });
    if (!clientId) return cb({ ok: false, error: 'Missing client id.' });

    if (socket.data.roomId) leaveRoom(socket);
    const returning = [...room.members.values()].some((m) => m.clientId === clientId);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.clientId = clientId;
    room.members.set(socket.id, { clientId, name });
    room.emptySince = null;
    if (!room.hostId) room.hostId = clientId;
    if (room.hostId === clientId) clearTimeout(room.hostTimer);

    cb({ ok: true, chat: room.chat, clientId });
    broadcastState(room);
    if (!returning) announce(room, `${name} joined`);
  });

  on('player:play', { control: true }, (room, { name }) => {
    if (!room.media) return { ok: false, error: 'Nothing is loaded yet.' };
    let pos = getPosition(room);
    if (room.media.duration && pos >= room.media.duration - 0.5) pos = 0; // replay from the start
    setPlayback(room, true, pos);
    announce(room, `${name} pressed play`);
  });

  on('player:pause', { control: true }, (room, { name }) => {
    if (!room.media) return;
    const pos = getPosition(room);
    setPlayback(room, false, pos);
    announce(room, `${name} paused at ${fmtTime(pos)}`);
  });

  on('player:seek', { control: true }, (room, { name }, data) => {
    if (!room.media || room.media.live) return;
    let t = Number(data.time);
    if (!Number.isFinite(t)) return { ok: false, error: 'Invalid time.' };
    t = Math.max(0, room.media.duration ? Math.min(t, room.media.duration) : t);
    setPlayback(room, room.playback.playing, t);
    announce(room, `${name} jumped to ${fmtTime(t)}`);
  });

  on('media:set', { control: true }, (room, { name }, data) => {
    const parsed = parseMediaUrl(data.url ?? '');
    if (parsed.error) return { ok: false, error: parsed.error };
    playNowOrQueue(room, { id: randomId(10), ...parsed, duration: null, addedBy: name }, data.mode, name);
  });

  // Players report what they learn after loading (length, real title, whether it's live).
  on('media:meta', {}, (room, ctx, data) => {
    const m = room.media;
    if (!m || data.mediaId !== m.id) return;
    let changed = false;
    if (data.live === true && !m.live) {
      m.live = true;
      m.duration = null;
      changed = true;
    }
    const d = Number(data.duration);
    if (!m.live && !m.duration && Number.isFinite(d) && d > 0 && d < 7 * 24 * 3600) {
      m.duration = d;
      changed = true;
    }
    if (m.titleFromClient && typeof data.title === 'string' && data.title.trim()) {
      m.title = clean(data.title, 120);
      m.titleFromClient = false;
      changed = true;
    }
    if (changed) broadcastState(room);
  });

  on('queue:play', { control: true }, (room, { name }, data) => {
    const i = room.queue.findIndex((q) => q.id === data.id);
    if (i < 0) return { ok: false, error: 'That item is no longer in the queue.' };
    const [item] = room.queue.splice(i, 1);
    loadMedia(room, item);
    announce(room, `${name} started "${item.title}"`);
  });

  on('queue:remove', { control: true }, (room, ctx, data) => {
    const i = room.queue.findIndex((q) => q.id === data.id);
    if (i < 0) return;
    const [item] = room.queue.splice(i, 1);
    deleteFileIfUnused(room, item);
    broadcastState(room);
  });

  on('queue:next', { control: true }, (room, { name }) => {
    if (!room.media) return;
    announce(room, `${name} skipped "${room.media.title}"`);
    if (room.queue.length) advance(room);
    else {
      const old = room.media;
      room.media = null;
      room.playback = { playing: false, position: 0, updatedAt: Date.now() };
      deleteFileIfUnused(room, old);
      broadcastState(room);
    }
  });

  on('room:settings', {}, (room, { clientId, name }, data) => {
    if (clientId !== room.hostId) return { ok: false, error: 'Only the host can change room settings.' };
    if (typeof data.everyoneCanControl === 'boolean' && data.everyoneCanControl !== room.everyoneCanControl) {
      room.everyoneCanControl = data.everyoneCanControl;
      broadcastState(room);
      announce(room, data.everyoneCanControl ? `${name} let everyone control playback` : `${name} made playback host-only`);
    }
  });

  /*
   * Voice chat signalling. Audio goes directly between browsers (WebRTC); the server only
   * introduces them: it tells a new voice participant who's already there and passes their
   * connection offers between them. Peers are identified by socket id (one per tab).
   */
  on('voice:join', {}, (room, { clientId, name }, data) => {
    const me = room.members.get(socket.id);
    if (!me) return { ok: false, error: 'Join the room first.' };
    me.voice = { muted: !!data.muted, hasMic: !!data.hasMic };
    const peers = [];
    for (const [sid, m] of room.members) {
      if (sid !== socket.id && m.voice) peers.push({ id: sid, clientId: m.clientId, name: m.name });
    }
    socket.to(room.id).emit('voice:peer-joined', { id: socket.id, clientId, name });
    broadcastState(room);
    return { ok: true, peers };
  });

  on('voice:leave', {}, (room) => {
    const me = room.members.get(socket.id);
    if (!me?.voice) return;
    me.voice = null;
    socket.to(room.id).emit('voice:peer-left', { id: socket.id });
    broadcastState(room);
  });

  on('voice:mute', {}, (room, ctx, data) => {
    const me = room.members.get(socket.id);
    if (!me?.voice) return;
    me.voice.muted = !!data.muted;
    broadcastState(room);
  });

  // Connection details (offer/answer/network candidates) for one other participant in the room.
  on('voice:signal', {}, (room, ctx, data) => {
    const to = String(data.to ?? '');
    if (!room.members.get(to)?.voice || !room.members.get(socket.id)?.voice) return;
    if (JSON.stringify(data.data ?? null).length > 20000) return { ok: false, error: 'Signal too large.' };
    io.to(to).emit('voice:signal', { from: socket.id, data: data.data });
  });

  let lastChatAt = 0;
  on('chat:send', {}, (room, { name }, data) => {
    const text = clean(data.text, 500);
    if (!text) return;
    if (Date.now() - lastChatAt < 300) return { ok: false, error: 'Slow down a little.' };
    lastChatAt = Date.now();
    addChat(room, { name, text, from: socket.data.clientId });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

// Server-side end detection: when the master clock passes the end, move on to the next video.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const m = room.media;
    if (m && m.duration && !m.live && room.playback.playing && getPosition(room, false) >= m.duration + 0.5) {
      advance(room);
    }
    if (room.members.size === 0 && room.emptySince && now - room.emptySince > ROOM_IDLE_MINUTES * 60000) {
      destroyRoom(room);
    }
  }
  for (const up of pendingUploads.values()) {
    if (!up.busy && now - up.lastActivity > UPLOAD_IDLE_MS) discardUpload(up);
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`2Watch running at http://localhost:${PORT}`);
});
