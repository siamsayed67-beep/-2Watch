'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { parseMediaUrl, MEDIA_EXTENSIONS } = require('./lib/media');

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
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 4096;
const ROOM_IDLE_MINUTES = Number(process.env.ROOM_IDLE_MINUTES) || 30;
const START_DELAY_MS = 1500; // every new video starts this long after it's loaded, so all viewers start together
const HOST_GRACE_MS = 20000; // a host who refreshes the page keeps the host role
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Rooms live in memory, so uploads left over from a previous run belong to nobody.
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Uploaded videos. express.static supports HTTP range requests, so viewers can seek
// and start mid-file without downloading everything first.
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '1d', fallthrough: false }));
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

function createRoom(name) {
  let id;
  do id = randomId(6); while (rooms.has(id));
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
  for (const file of room.files) fs.unlink(path.join(UPLOAD_DIR, file), () => {});
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
    if (!users.has(m.clientId)) users.set(m.clientId, { id: m.clientId, name: m.name });
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
  fs.unlink(path.join(UPLOAD_DIR, item.file), () => {});
  room.files.delete(item.file);
}

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
app.get('/api/config', (req, res) => {
  res.json(authEnabled ? { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } : {});
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

function decodeFilename(name) {
  // Multipart filenames arrive as latin1; most browsers actually send UTF-8.
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + safeExt(file.originalname)),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^(video|audio)\//.test(file.mimetype) || MEDIA_EXTENSIONS.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('Only video or audio files can be uploaded.'), { status: 415 }));
  },
});

app.post('/api/rooms/:id/upload', async (req, res) => {
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

  upload.single('video')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `That file is too large (max ${MAX_UPLOAD_MB} MB).` : err.message;
      return res.status(err.status || 400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file was received.' });
    if (!rooms.has(room.id)) {
      fs.unlink(req.file.path, () => {});
      return res.status(410).json({ error: 'The room has closed.' });
    }
    room.files.add(req.file.filename);
    const item = {
      id: randomId(10),
      kind: 'file',
      file: req.file.filename,
      src: `/media/${req.file.filename}`,
      title: clean(decodeFilename(req.file.originalname), 120, 'Uploaded video'),
      duration: null,
      addedBy: name,
    };
    playNowOrQueue(room, item, req.query.mode, name);
    res.json({ ok: true });
  });
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

  const stillHere = [...room.members.values()].some((m) => m.clientId === me.clientId);
  if (!stillHere) announce(room, `${me.name} left`);
  if (room.members.size === 0) room.emptySince = Date.now();

  if (me.clientId === room.hostId && !stillHere) {
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
  broadcastState(room);
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
    if (!room) return cb({ ok: false, error: 'This room does not exist or has closed.' });
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
}, 1000);

server.listen(PORT, () => {
  console.log(`2Watch running at http://localhost:${PORT}`);
});
