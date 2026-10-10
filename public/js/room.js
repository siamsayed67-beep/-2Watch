'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const store = {
    get(k) { try { return localStorage.getItem('2watch.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('2watch.' + k, v); } catch {} },
  };

  const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  // Replaced by the Supabase user id once the server confirms who we are.
  let clientId =
    store.get('clientId') ||
    (() => {
      const id = crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
      store.set('clientId', id);
      return id;
    })();

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    skip: '<svg viewBox="0 0 24 24"><path d="M6 5.5v13l9-6.5zM16 5.5h2.5v13H16z"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  };
  const KIND_LABEL = { file: 'Upload', direct: 'Link', youtube: 'YouTube', facebook: 'Facebook', vimeo: 'Vimeo', twitch: 'Twitch' };

  let socket = null;
  let myName = '';
  let state = null; // last room state from the server
  let playback = null; // { playing, position, updatedAt, mediaId }: the room's master clock

  // Clock sync: serverTime ≈ Date.now() + clockOffset
  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;

  let adapter = null;
  let adapterReady = false;
  let mountedId; // id of the media currently mounted in the stage
  let lastSeekAt = 0;
  let leadCheckAt = 0;
  let playAttemptAt = 0;
  let pausedWhileWantedSince = 0;
  let lastDrift = null;
  let draggingSeek = false;

  let volume = parseFloat(store.get('volume'));
  if (!Number.isFinite(volume)) volume = 0.8;
  let muted = store.get('muted') === '1';

  // youtubeBlock: YouTube refused to play here; shown as a strip so YouTube's own screen stays usable.
  const overlay = { error: null, youtubeBlock: null, blocked: false, countdown: 0, loading: null, buffering: false };

  // Smooth mode: the server makes lower-quality copies of uploads (HLS). Viewers whose connection
  // can't keep up with the original are switched to them, and their player picks the best
  // quality the connection can sustain.
  let adaptiveMounted = false; // the current upload is playing in smooth mode
  const wantAdaptive = new Set(); // uploads this viewer should watch in smooth mode
  let stallTimes = []; // when the video recently paused to load
  let bufferingSince = 0;
  let quality = null; // current smooth-mode quality, e.g. "480p"
  let waitingForCompatible = false; // the browser can't play the original; waiting for the converted copy

  const isHost = () => state?.hostId === clientId;
  const canControl = () => !!state && (state.everyoneCanControl || isHost());

  /** Where the video should be right now according to the room's clock (may be negative during the start countdown). */
  function targetTime() {
    if (!playback) return 0;
    if (!playback.playing) return playback.position;
    return playback.position + (serverNow() - playback.updatedAt) / 1000;
  }
  const isLive = () => !!(state?.media?.live || adapter?.live);
  const mediaDuration = () => state?.media?.duration || (adapterReady && adapter?.getDuration()) || 0;

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function send(event, data = {}) {
    return new Promise((resolve) => {
      if (!socket?.connected) {
        toast('Not connected. Reconnecting…');
        return resolve(null);
      }
      socket.timeout(8000).emit(event, data, (err, res) => {
        if (err) toast('The server did not respond.');
        else if (res?.ok === false) toast(res.error);
        resolve(err ? null : res);
      });
    });
  }

  /* ------------------------------------------------------------- joining */

  function fatal(msg) {
    $('joinModal').hidden = false;
    $('joinForm').innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = msg;
    const a = document.createElement('a');
    a.href = '/';
    a.className = 'btn primary big';
    a.textContent = 'Start a new room';
    $('joinForm').append(h, a);
    socket?.disconnect();
  }

  /*
   * Rooms live in the server's memory, so a server restart loses them. This browser keeps a
   * copy of its room (also saved locally, so it survives a page refresh). If the room is gone
   * when we reconnect, we ask the server to recreate it from that copy and carry on.
   */
  const SNAPSHOT_KEY = `room.${roomId}`;
  const SNAPSHOT_MAX_AGE_MS = 12 * 3600 * 1000;

  function roomSnapshot() {
    if (!state) return null;
    const item = (m) => m && { kind: m.kind, src: m.src, title: m.title, duration: m.duration, addedBy: m.addedBy };
    return {
      name: state.name,
      everyoneCanControl: state.everyoneCanControl,
      hostId: state.hostId,
      media: item(state.media),
      queue: state.queue.map(item),
      playback: { playing: !!playback?.playing, position: Math.max(0, targetTime()) },
      savedAt: Date.now(),
    };
  }

  function saveSnapshot() {
    const snap = roomSnapshot();
    if (snap) store.set(SNAPSHOT_KEY, JSON.stringify(snap));
  }

  function savedSnapshot() {
    try {
      const snap = JSON.parse(store.get(SNAPSHOT_KEY));
      if (!snap || Date.now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS) return null;
      // The video kept playing for everyone while this copy sat here.
      if (snap.playback?.playing) snap.playback.position += (Date.now() - snap.savedAt) / 1000;
      return snap;
    } catch {
      return null;
    }
  }

  fetch(`/api/rooms/${encodeURIComponent(roomId)}`)
    .then((r) => (r.ok ? r.json() : r.status === 404 ? { missing: true } : Promise.reject()))
    .then((info) => {
      if (info.missing) {
        // Gone from the server, but we can bring it back if this browser was in it recently.
        const snap = savedSnapshot();
        if (!snap) return fatal('This room does not exist or has closed.');
        info = { name: snap.name };
      }
      $('joinRoomName').textContent = info.name;
      $('roomName').textContent = info.name;
      document.title = `${info.name} · 2Watch`;
      if (info.maxUploadMb) $('dzSub').textContent += ` · up to ${info.maxUploadMb >= 1024 ? (info.maxUploadMb / 1024).toFixed(0) + ' GB' : info.maxUploadMb + ' MB'}`;
    })
    .catch(() => fatal('Could not reach the server. Refresh the page to try again.'));

  let accountsOn = false;
  const goSignIn = () => location.replace(`/?next=${encodeURIComponent(location.pathname)}`);

  // With accounts switched on, only signed-in people can join; everyone else is sent to sign in first.
  Auth.ready
    .then(async (enabled) => {
      accountsOn = enabled;
      if (!enabled) {
        $('nameInput').value = store.get('name') || '';
        $('nameField').hidden = false;
      } else {
        const session = await Auth.getSession();
        if (!session) return goSignIn();
        myName = Auth.displayName(session.user);
        $('joiningAs').textContent = `Joining as ${myName}`;
        $('joiningAs').hidden = false;
      }
      $('joinBtn').disabled = false;
    })
    .catch(() => fatal('Could not load the sign-in service. Refresh the page to try again.'));

  const accessToken = async () => (accountsOn ? (await Auth.getSession())?.access_token : undefined);

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    // This click also counts as the user gesture browsers require before playing sound.
    if (!accountsOn) {
      myName = $('nameInput').value.trim() || 'Guest';
      store.set('name', myName);
    }
    $('joinModal').hidden = true;
    connect();
  });

  function connect() {
    socket = io();
    socket.on('connect', async () => {
      setConnStatus(null);
      // Fetched on every (re)connect so a refreshed token is used after long sessions.
      const token = await accessToken();
      const join = () => new Promise((resolve) => socket.emit('room:join', { roomId, clientId, name: myName, token }, resolve));
      let res = await join();
      if (res?.notFound) {
        // The server restarted and lost the room: recreate it from our copy, then join again.
        const snapshot = roomSnapshot() || savedSnapshot();
        if (snapshot) {
          await new Promise((resolve) => socket.emit('room:restore', { roomId, name: myName, token, snapshot }, resolve));
          res = await join();
        }
      }
      if (res?.needsAuth) return goSignIn();
      if (!res?.ok) return fatal(res?.error || 'Could not join the room.');
      clientId = res.clientId;
      $('chatLog').replaceChildren();
      res.chat.forEach(addChatMessage);
      syncClock();
    });
    socket.on('disconnect', () => setConnStatus('Reconnecting…'));
    socket.on('room:state', onState);
    socket.on('playback', (p) => {
      playback = p;
      if (state) state.playback = p;
      renderControls();
      syncTick();
    });
    socket.on('chat:message', addChatMessage);

    setInterval(syncClock, 30000);
    setInterval(syncTick, 250);
    setInterval(renderTimeline, 200);
    setInterval(saveSnapshot, 5000);
  }

  function setConnStatus(text) {
    $('connStatus').hidden = !text;
    $('connStatus').textContent = text || '';
  }

  /** NTP-style offset estimate: keep the sample with the lowest round trip. */
  async function syncClock() {
    const samples = [];
    for (let i = 0; i < 5 && socket?.connected; i++) {
      const t0 = Date.now();
      const st = await new Promise((r) => socket.timeout(3000).emit('time:ping', (err, s) => r(err ? null : s)));
      const t1 = Date.now();
      if (typeof st === 'number') samples.push({ rtt: t1 - t0, offset: st + (t1 - t0) / 2 - t1 });
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!samples.length) return;
    samples.sort((a, b) => a.rtt - b.rtt);
    clockOffset = samples[0].offset;
  }

  /* --------------------------------------------------------- room state */

  function onState(s) {
    state = s;
    playback = s.playback;
    saveSnapshot();
    $('roomName').textContent = s.name;
    document.title = `${s.name} · 2Watch`;
    renderUsers();
    renderQueue();
    renderNowPlaying();
    renderControls();
    const m = s.media;
    if ((m?.id ?? null) !== mountedId) mountMedia(m);
    else if (smoothReady(m) && wantAdaptive.has(m.id) && !adaptiveMounted) switchToAdaptive();
    else if (waitingForCompatible) showIncompatible(m);
    renderQuality();
    syncTick();
  }

  // Smooth mode is usable once encoding is done, or far enough ahead of the room that the
  // viewer won't catch up with it (it normally runs several times faster than playback).
  function smoothReady(m) {
    if (!m?.adaptiveSrc) return false;
    return m.adaptive?.status === 'ready' || (m.adaptive?.encodedUntil ?? 0) > Math.max(0, targetTime()) + 20;
  }

  function switchToAdaptive(reason) {
    const m = state?.media;
    if (!smoothReady(m) || adaptiveMounted) return;
    wantAdaptive.add(m.id);
    if (reason) toast(reason);
    mountMedia(m);
  }

  // Whether this viewer keeps pausing to load, i.e. their connection is slower than the video.
  function isStruggling() {
    const now = performance.now();
    stallTimes = stallTimes.filter((t) => now - t < 60000);
    return stallTimes.length >= 2 || (bufferingSince && now - bufferingSince > 3000);
  }

  function checkSmoothMode() {
    const m = state?.media;
    if (m?.kind !== 'file' || adaptiveMounted || !isStruggling()) return;
    if (smoothReady(m)) {
      switchToAdaptive("Your connection is slower than this video needs, so you're now in smooth mode: the quality adjusts to your connection.");
    } else {
      wantAdaptive.add(m.id); // switch as soon as the copies are ready
    }
  }

  function showIncompatible(m) {
    const a = m?.adaptive;
    overlay.error = !a
      ? "Your browser can't play this file's format. Ask the uploader for an MP4 (H.264) version."
      : a.status === 'failed'
        ? "Your browser can't play this file's format, and it couldn't be converted."
        : `Your browser can't play this file's format. A compatible version is being prepared${a.status === 'encoding' ? ` (${Math.round((a.progress || 0) * 100)}%)` : ''} and will start automatically.`;
    renderOverlay();
  }

  function renderQuality() {
    const pill = $('qualityPill');
    const m = state?.media;
    pill.onclick = null;
    pill.classList.remove('clickable');
    let text = '';
    if (m?.kind === 'file') {
      if (adaptiveMounted) text = `Smooth mode · ${quality || 'auto'}`;
      else if (smoothReady(m)) {
        text = 'Lagging? Use smooth mode';
        pill.classList.add('clickable');
        pill.onclick = () => switchToAdaptive();
      } else if (m.adaptive?.status === 'encoding') text = `Preparing smooth mode ${Math.round((m.adaptive.progress || 0) * 100)}%`;
      else if (m.adaptive?.status === 'queued') text = 'Smooth mode queued';
    }
    pill.textContent = text;
    pill.hidden = !text;
  }

  function mountMedia(media) {
    // Smooth mode starts loading at the room's current moment instead of the beginning.
    const useAdaptive = !!(media?.kind === 'file' && smoothReady(media) && wantAdaptive.has(media.id));
    const source = useAdaptive ? { ...media, src: media.adaptiveSrc, hls: true, startAt: Math.max(0, targetTime()) } : media;
    adaptiveMounted = useAdaptive;
    quality = null;
    stallTimes = [];
    bufferingSince = 0;
    waitingForCompatible = false;
    if (adapter) {
      try { adapter.destroy(); } catch {}
    }
    adapter = null;
    adapterReady = false;
    lastSeekAt = 0;
    leadCheckAt = 0;
    lastDrift = null;
    pausedWhileWantedSince = 0;
    Object.assign(overlay, { error: null, youtubeBlock: null, blocked: false, loading: null, buffering: false });
    mountedId = media?.id ?? null;
    $('stageMedia').replaceChildren();
    $('stageEmpty').hidden = !!media;
    renderOverlay();
    if (!media) return;

    let a;
    try {
      const Adapter = Players.adapterFor(media.kind);
      a = new Adapter($('stageMedia'), source, {
        onMeta: (meta) => adapter === a && socket.emit('media:meta', { mediaId: media.id, ...meta }),
        onError: (msg, info) => {
          if (adapter !== a) return;
          if (info?.youtubeBlocked) {
            overlay.loading = null;
            overlay.youtubeBlock = { url: media.src };
            return renderOverlay();
          }
          // The browser can't decode this format (e.g. HEVC/MKV): use the converted copy instead.
          if (info?.unsupported && media.kind === 'file' && !useAdaptive) {
            wantAdaptive.add(media.id);
            if (smoothReady(state?.media)) return switchToAdaptive();
            waitingForCompatible = true;
            overlay.loading = null;
            return showIncompatible(state?.media);
          }
          overlay.error = msg;
          renderOverlay();
        },
        onBuffering: (b) => {
          if (adapter !== a) return;
          overlay.buffering = b;
          const now = performance.now();
          if (b) {
            bufferingSince = now;
            if (adapterReady && playback?.playing && targetTime() > 1) stallTimes.push(now);
          } else {
            bufferingSince = 0;
          }
          renderOverlay();
          checkSmoothMode();
        },
        onQuality: (label) => {
          if (adapter !== a) return;
          quality = label;
          renderQuality();
        },
      });
    } catch (err) {
      overlay.error = err.message;
      renderOverlay();
      return;
    }
    adapter = a;
    overlay.loading = 'Loading video…';
    renderOverlay();
    a.ready
      .then(() => {
        if (adapter !== a) return;
        adapterReady = true;
        overlay.loading = null;
        renderOverlay();
        a.setVolume(volume);
        a.setMuted(muted);
        syncTick();
      })
      .catch((err) => {
        if (adapter !== a || err?.unsupported) return; // unsupported formats are handled in onError
        overlay.loading = null;
        overlay.error = err?.message || 'This video could not be loaded.';
        renderOverlay();
      });
    renderQuality();
  }

  /* ------------------------------------------------------------ sync engine */

  /*
   * Runs 4x a second. Compares the local player with the room clock and corrects it:
   *  - play/pause state always follows the room
   *  - small drift on uploaded files / direct links: speed up or slow down slightly (invisible)
   *  - larger drift (or embeds that can't change speed): jump to the right moment
   */
  function syncTick() {
    const a = adapter;
    if (!a || !adapterReady || !playback || playback.mediaId !== mountedId || overlay.error || overlay.youtubeBlock) {
      if (overlay.countdown) {
        overlay.countdown = 0;
        renderOverlay();
      }
      return;
    }
    const now = performance.now();
    const live = isLive();
    const dur = mediaDuration();
    let target = targetTime();
    let shouldPlay = playback.playing;

    const countdown = shouldPlay && target < 0 ? Math.ceil(-target) : 0;
    if (countdown !== overlay.countdown) {
      overlay.countdown = countdown;
      renderOverlay();
    }
    if (target < 0) {
      shouldPlay = false;
      target = 0;
    }
    if (!live && dur && target >= dur) {
      target = dur;
      shouldPlay = false;
    }

    let current;
    try {
      current = a.getTime();
    } catch {
      return;
    }

    if (!shouldPlay) {
      pausedWhileWantedSince = 0;
      setBlocked(false);
      if (!a.isPaused()) a.pause();
      if (!live && Math.abs(current - target) > 0.25 && now - lastSeekAt > 800) {
        a.seek(target);
        lastSeekAt = now;
      }
      if (a.canRate) a.setRate(1);
      lastDrift = live ? null : current - target;
      return;
    }

    if (a.isPaused()) tryPlay(now);
    else {
      pausedWhileWantedSince = 0;
      setBlocked(false);
    }

    if (live) {
      lastDrift = null;
      return;
    }
    checkSmoothMode();
    const drift = current - target;
    lastDrift = drift;
    // Embeds take a moment to resume after a jump. Learn how long, so the next jump lands on target.
    if (leadCheckAt && now - leadCheckAt > 2000 && !overlay.buffering) {
      a.seekLead = clamp(a.seekLead - clamp(drift * 0.8, -0.5, 0.5), 0, 3);
      leadCheckAt = 0;
    }
    if (Math.abs(drift) > a.hardSyncThreshold) {
      // Jumping to a moment that hasn't downloaded yet only causes another pause. So while the
      // video is loading, don't jump; jump straight away only if the target is already loaded;
      // otherwise catch up by playing slightly faster and jump only if that isn't enough.
      const targetLoaded = a.isBuffered ? a.isBuffered(target) : true;
      if (!overlay.buffering && now - lastSeekAt > (targetLoaded ? 2500 : 10000)) {
        a.seek(target + a.seekLead);
        lastSeekAt = now;
        if (a.canRate) a.setRate(1);
        else leadCheckAt = now;
      } else if (a.canRate) {
        a.setRate(clamp(1 - drift * 0.6, 0.9, 1.1));
      }
    } else if (a.canRate) {
      a.setRate(Math.abs(drift) < 0.04 ? 1 : clamp(1 - drift * 0.6, 0.9, 1.1));
    }
  }

  function tryPlay(now) {
    if (!pausedWhileWantedSince) pausedWhileWantedSince = now;
    if (now - playAttemptAt > 1000) {
      playAttemptAt = now;
      try {
        Promise.resolve(adapter.play()).catch((err) => {
          if (err?.name === 'NotAllowedError') setBlocked(true);
        });
      } catch {}
    }
    // Embeds don't report autoplay blocking, so if it still hasn't started after a while, ask for a click.
    if (now - pausedWhileWantedSince > 5000 && !overlay.buffering) setBlocked(true);
  }

  function setBlocked(b) {
    if (overlay.blocked === b) return;
    overlay.blocked = b;
    renderOverlay();
  }

  function unblockPlayback() {
    const a = adapter;
    if (!a) return;
    setBlocked(false);
    pausedWhileWantedSince = performance.now();
    try {
      Promise.resolve(a.play()).catch(() => {});
    } catch {}
    // Last resort: browsers always allow muted playback.
    setTimeout(() => {
      if (adapter === a && playback?.playing && a.isPaused()) {
        muted = true;
        a.setMuted(true);
        try { Promise.resolve(a.play()).catch(() => {}); } catch {}
        renderVolume();
        toast('Playing muted because your browser blocked sound. Click the speaker icon to unmute.');
      }
    }, 1500);
  }

  /* ----------------------------------------------------------- rendering */

  function renderOverlay() {
    const el = $('stageOverlay');
    el.className = 'stage-overlay';
    el.onclick = null;
    // Let clicks reach YouTube's own screen (e.g. its "Sign in" button) while it's refusing to play.
    $('stageShield').hidden = !!overlay.youtubeBlock;
    if (overlay.youtubeBlock) return renderYoutubeBlock(el);
    let content = null;
    if (overlay.error) {
      el.classList.add('is-error');
      content = [['strong', "Can't play this video"], ['p', overlay.error]];
      if (canControl() && state?.queue.length) content.push(['p', 'Use the skip button to move on to the next video.']);
    } else if (overlay.blocked) {
      el.classList.add('is-action');
      content = [['div', '▶', 'big-play'], ['strong', 'Click to start playback'], ['p', 'Your browser needs a click before it plays video with sound.']];
      el.onclick = unblockPlayback;
    } else if (overlay.countdown) {
      content = [['div', String(overlay.countdown), 'countdown'], ['p', 'Starting for everyone…']];
    } else if (overlay.loading) {
      content = [['div', '', 'spinner'], ['p', overlay.loading]];
    } else if (overlay.buffering) {
      el.classList.add('is-subtle');
      content = [['div', '', 'spinner']];
    }
    el.hidden = !content;
    el.replaceChildren(
      ...(content || []).map(([tag, text, cls]) => {
        const n = document.createElement(tag);
        n.textContent = text;
        if (cls) n.className = cls;
        return n;
      }),
    );
  }

  function renderYoutubeBlock(el) {
    el.classList.add('is-notice');
    const title = document.createElement('strong');
    title.textContent = "YouTube won't play this video here";
    const text = document.createElement('p');
    text.textContent =
      'If YouTube asks you to sign in to confirm you’re not a bot, sign in on its screen above (or turn off your VPN) and press Try again. If it doesn’t, the video’s owner has blocked playing it on other websites.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn small primary';
    retry.textContent = 'Try again';
    retry.onclick = () => mountMedia(state?.media);
    const open = document.createElement('a');
    open.className = 'btn small';
    open.href = overlay.youtubeBlock.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open on YouTube';
    const head = document.createElement('div');
    head.className = 'notice-head';
    head.append(title, retry, open);
    el.replaceChildren(head, text);
    el.hidden = false;
  }

  function renderUsers() {
    const ul = $('users');
    ul.replaceChildren(
      ...state.users.map((u) => {
        const li = document.createElement('li');
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.textContent = (u.name[0] || '?').toUpperCase();
        avatar.style.setProperty('--hue', hashHue(u.id));
        const name = document.createElement('span');
        name.className = 'user-name';
        name.textContent = u.name;
        li.append(avatar, name);
        if (u.id === state.hostId) li.append(tag('host', 'Host'));
        if (u.id === clientId) li.append(tag('you', 'You'));
        return li;
      }),
    );
    const n = state.users.length;
    $('viewerCount').textContent = `${n} watching`;
    $('hostSetting').hidden = !isHost();
    $('everyoneCtl').checked = state.everyoneCanControl;
  }

  function tag(cls, text) {
    const s = document.createElement('span');
    s.className = 'tag ' + cls;
    s.textContent = text;
    return s;
  }

  function hashHue(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return String(h % 360);
  }

  function renderQueue() {
    const ol = $('queue');
    const control = canControl();
    ol.replaceChildren(
      ...state.queue.map((item) => {
        const li = document.createElement('li');
        const badge = document.createElement('span');
        badge.className = `badge kind-${item.kind}`;
        badge.textContent = KIND_LABEL[item.kind] || item.kind;
        const info = document.createElement('div');
        info.className = 'q-info';
        const title = document.createElement('span');
        title.className = 'q-title';
        title.textContent = item.title;
        const by = document.createElement('span');
        by.className = 'q-by';
        by.textContent = `added by ${item.addedBy}`;
        info.append(title, by);
        li.append(badge, info);
        if (control) {
          const play = document.createElement('button');
          play.className = 'btn small';
          play.type = 'button';
          play.textContent = 'Play now';
          play.onclick = () => send('queue:play', { id: item.id });
          const rm = document.createElement('button');
          rm.className = 'btn small ghost';
          rm.type = 'button';
          rm.textContent = 'Remove';
          rm.onclick = () => send('queue:remove', { id: item.id });
          li.append(play, rm);
        }
        return li;
      }),
    );
    $('queueEmpty').hidden = state.queue.length > 0;
  }

  function renderNowPlaying() {
    const m = state.media;
    $('nowPlaying').hidden = !m;
    if (!m) return;
    $('npKind').textContent = KIND_LABEL[m.kind] || m.kind;
    $('npKind').className = `badge kind-${m.kind}`;
    $('npTitle').textContent = m.title;
    $('npBy').textContent = `added by ${m.addedBy}`;
  }

  function renderControls() {
    if (!state) return;
    const control = canControl();
    const hasMedia = !!state.media;
    $('playBtn').disabled = !control || !hasMedia;
    $('seek').disabled = !control || !hasMedia || isLive();
    $('skipBtn').disabled = !control || !hasMedia;
    $('lockedNote').hidden = control;
    $('addCard').classList.toggle('disabled', !control);
    for (const el of $('addCard').querySelectorAll('input, button')) el.disabled = !control || (el.id.startsWith('upload') && !selectedFile);
    const playing = !!playback?.playing;
    $('playBtn').innerHTML = playing ? ICON.pause : ICON.play;
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function renderTimeline() {
    if (!state) return;
    const dur = mediaDuration();
    const live = isLive();
    const t = clamp(targetTime(), 0, dur || Infinity);
    const seek = $('seek');
    if (!draggingSeek) {
      seek.max = String(dur || 0);
      seek.value = String(t);
    }
    seek.style.setProperty('--pct', dur ? `${(Number(seek.value) / dur) * 100}%` : '0%');
    $('timeCur').textContent = state.media ? fmt(draggingSeek ? Number(seek.value) : t) : '0:00';
    $('timeDur').textContent = live ? 'LIVE' : dur ? fmt(dur) : '--:--';
    $('timeDur').classList.toggle('live', live);

    const pill = $('syncPill');
    if (lastDrift == null || !adapterReady || !playback?.playing) {
      pill.textContent = live ? 'Live' : '';
      pill.className = 'sync-pill';
    } else {
      const ms = Math.round(Math.abs(lastDrift) * 1000);
      const ok = ms < 300;
      pill.textContent = ok ? `In sync (±${ms} ms)` : `Syncing… ${(lastDrift > 0 ? '+' : '−') + (ms / 1000).toFixed(1)}s`;
      pill.className = 'sync-pill ' + (ok ? 'ok' : 'warn');
    }
  }

  function renderVolume() {
    $('volume').value = String(muted ? 0 : volume);
    $('volume').style.setProperty('--pct', `${(muted ? 0 : volume) * 100}%`);
    $('muteBtn').innerHTML = muted || volume === 0 ? ICON.muted : ICON.volume;
  }

  /* -------------------------------------------------------------- controls */

  $('skipBtn').innerHTML = ICON.skip;
  $('fsBtn').innerHTML = ICON.fullscreen;
  renderVolume();

  function togglePlay() {
    if (!state?.media) return;
    if (!canControl()) return toast('Only the host can control playback in this room.');
    send(playback?.playing ? 'player:pause' : 'player:play');
  }

  function seekBy(delta) {
    if (!state?.media || isLive() || !canControl()) return;
    send('player:seek', { time: clamp(targetTime() + delta, 0, mediaDuration() || Infinity) });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('player').requestFullscreen?.().catch(() => {});
  }

  $('playBtn').onclick = togglePlay;
  $('stageShield').onclick = togglePlay;
  $('stageShield').ondblclick = toggleFullscreen;
  $('skipBtn').onclick = () => send('queue:next');
  $('fsBtn').onclick = toggleFullscreen;

  const seek = $('seek');
  seek.addEventListener('pointerdown', () => (draggingSeek = true));
  seek.addEventListener('input', () => (draggingSeek = true));
  seek.addEventListener('change', () => {
    draggingSeek = false;
    send('player:seek', { time: Number(seek.value) });
  });

  $('muteBtn').onclick = () => {
    muted = !muted;
    if (!muted && volume === 0) volume = 0.5;
    applyVolume();
  };
  $('volume').addEventListener('input', (e) => {
    volume = Number(e.target.value);
    muted = volume === 0;
    applyVolume();
  });
  function applyVolume() {
    store.set('volume', String(volume));
    store.set('muted', muted ? '1' : '0');
    if (adapterReady) {
      adapter.setVolume(volume);
      adapter.setMuted(muted);
    }
    renderVolume();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('joinModal').hidden) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'f') toggleFullscreen();
    else if (k === 'm') $('muteBtn').click();
    else if (k === 'arrowleft') seekBy(-10);
    else if (k === 'arrowright') seekBy(10);
  });

  $('everyoneCtl').addEventListener('change', (e) => send('room:settings', { everyoneCanControl: e.target.checked }));

  $('shareBtn').onclick = async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Invite link copied. Send it to your friends!');
  };

  /* ------------------------------------------------------------- add media */

  for (const tabBtn of document.querySelectorAll('.tab')) {
    tabBtn.onclick = () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tabBtn);
      for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== tabBtn.dataset.tab;
    };
  }

  $('linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('linkInput').value.trim();
    if (!url) return;
    const res = await send('media:set', { url, mode: e.submitter?.value || 'now' });
    if (res?.ok) $('linkInput').value = '';
  });

  let selectedFile = null;
  let currentUpload = null;

  function selectFile(file) {
    if (!file) return;
    selectedFile = file;
    $('dzLabel').textContent = file.name;
    $('dzSub').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · ready to upload`;
    renderControls();
  }

  $('fileInput').addEventListener('change', (e) => selectFile(e.target.files[0]));
  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (canControl()) selectFile(e.dataTransfer.files[0]);
  });

  $('uploadNow').onclick = () => startUpload('now');
  $('uploadQueue').onclick = () => startUpload('queue');
  $('uploadCancel').onclick = () => {
    if (!currentUpload) return;
    currentUpload.cancelled = true;
    currentUpload.xhr?.abort();
  };

  // Leaving the page would stop an upload, so ask first.
  window.addEventListener('beforeunload', (e) => {
    if (!currentUpload) return;
    e.preventDefault();
    e.returnValue = '';
  });

  const UPLOAD_MAX_RETRIES = 12;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CANCELLED = new Error('Upload cancelled.');

  async function uploadApi(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'X-Client-Id': clientId };
    const token = await accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Upload failed (${res.status}).`), { status: res.status });
    return data;
  }

  /** Sends one piece of the file. Rejects with { status, body }, { status: 0 } for network errors, or { aborted }. */
  function sendPiece(upload, url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = (upload.xhr = new XMLHttpRequest());
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 400) resolve(body);
        else reject({ status: xhr.status, body });
      };
      xhr.onerror = () => reject({ status: 0 });
      xhr.onabort = () => reject({ aborted: true });
      xhr.send(blob);
    });
  }

  // Network drops, timeouts and overloaded proxies are worth retrying; anything else is a real error.
  const isRetryable = (status) => status === 0 || status === 408 || status === 429 || (status >= 500 && status !== 507);

  function fmtDuration(sec) {
    if (!Number.isFinite(sec)) return '';
    if (sec < 60) return 'less than a minute left';
    const m = Math.round(sec / 60);
    return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h ${m % 60} min left`;
  }

  async function startUpload(mode) {
    if (!selectedFile || currentUpload) return;
    const file = selectedFile;
    const upload = (currentUpload = { cancelled: false, xhr: null, id: null });

    $('uploadProgress').hidden = false;
    $('uploadNow').hidden = $('uploadQueue').hidden = true;
    const setProgress = (pct, text) => {
      $('uploadBar').style.width = pct + '%';
      $('uploadText').textContent = text;
    };
    setProgress(0, 'Starting…');

    try {
      const { uploadId, chunkSize } = await uploadApi('POST', `/api/rooms/${encodeURIComponent(roomId)}/uploads`, {
        name: file.name,
        size: file.size,
        type: file.type,
      });
      upload.id = uploadId;

      let offset = 0;
      let failures = 0;
      const started = performance.now();
      const report = (sent) => {
        const secs = (performance.now() - started) / 1000;
        const rate = secs > 1 ? sent / secs : 0;
        const pct = (sent / file.size) * 100;
        const eta = rate > 0 ? fmtDuration((file.size - sent) / rate) : '';
        setProgress(pct, `${pct.toFixed(0)}%${rate ? ` · ${(rate / 1048576).toFixed(1)} MB/s` : ''}${eta ? ` · ${eta}` : ''}`);
      };

      while (offset < file.size) {
        if (upload.cancelled) throw CANCELLED;
        const piece = file.slice(offset, offset + chunkSize);
        try {
          const res = await sendPiece(upload, `/api/uploads/${uploadId}?offset=${offset}`, piece, (loaded) => report(offset + loaded));
          offset = res.received;
          failures = 0;
          report(offset);
        } catch (err) {
          if (err.aborted || upload.cancelled) throw CANCELLED;
          // The server is ahead or behind us (e.g. it saved a piece whose reply got lost): continue from its position.
          if (err.status === 409 && Number.isFinite(err.body?.received)) {
            offset = err.body.received;
            continue;
          }
          if (!isRetryable(err.status)) throw new Error(err.body?.error || `Upload failed (${err.status}).`);
          if (++failures > UPLOAD_MAX_RETRIES) {
            throw new Error('The connection kept dropping, so the upload stopped. Check your internet and try again.');
          }
          const wait = Math.min(30000, 1000 * 2 ** (failures - 1));
          setProgress((offset / file.size) * 100, `Connection problem. Retrying in ${Math.round(wait / 1000)} s…`);
          await sleep(wait);
        }
      }

      setProgress(100, 'Finishing…');
      for (let attempt = 1; ; attempt++) {
        try {
          await uploadApi('POST', `/api/uploads/${uploadId}/complete`, { mode });
          break;
        } catch (err) {
          if (upload.cancelled) throw CANCELLED;
          if (err.status || attempt >= 5) throw err; // a real error from the server, or still offline
          await sleep(2000 * attempt);
        }
      }

      selectedFile = null;
      $('fileInput').value = '';
      $('dzLabel').innerHTML = 'Drop a video here or <u>choose a file</u>';
      $('dzSub').textContent = 'MP4 (H.264/AAC) or WebM plays in every browser';
      finishUpload(mode === 'queue' ? 'Uploaded and added to the queue.' : 'Uploaded! Starting for everyone…');
    } catch (err) {
      // Throw away the partial file on the server.
      if (upload.id) fetch(`/api/uploads/${upload.id}`, { method: 'DELETE' }).catch(() => {});
      finishUpload(err === CANCELLED ? 'Upload cancelled.' : err.message || 'Upload failed.');
    }
  }

  function finishUpload(msg) {
    currentUpload = null;
    $('uploadProgress').hidden = true;
    $('uploadNow').hidden = $('uploadQueue').hidden = false;
    renderControls();
    if (msg) toast(msg);
  }

  /* ------------------------------------------------------------------ chat */

  function addChatMessage(m) {
    const log = $('chatLog');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const div = document.createElement('div');
    div.className = m.system ? 'msg system' : 'msg' + (m.from === clientId ? ' mine' : '');
    if (!m.system) {
      const who = document.createElement('span');
      who.className = 'msg-name';
      who.textContent = m.name;
      who.style.setProperty('--hue', hashHue(m.from || m.name));
      div.append(who);
    }
    const text = document.createElement('span');
    text.className = 'msg-text';
    text.textContent = m.text;
    div.append(text);
    div.title = new Date(m.at).toLocaleTimeString();
    log.append(div);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await send('chat:send', { text });
  });
})();
