'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const store = {
    get(k) { try { return localStorage.getItem('2watch.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('2watch.' + k, v); } catch {} },
  };

  const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const clientId =
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

  const overlay = { error: null, blocked: false, countdown: 0, loading: null, buffering: false };

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

  fetch(`/api/rooms/${encodeURIComponent(roomId)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((info) => {
      $('joinRoomName').textContent = info.name;
      $('roomName').textContent = info.name;
      document.title = `${info.name} · 2Watch`;
      if (info.maxUploadMb) $('dzSub').textContent += ` · up to ${info.maxUploadMb >= 1024 ? (info.maxUploadMb / 1024).toFixed(0) + ' GB' : info.maxUploadMb + ' MB'}`;
    })
    .catch(() => fatal('This room does not exist or has closed.'));

  // Load initial name from auth or localStorage
  Auth.init().then(({ user, authEnabled }) => {
    if (authEnabled && user) {
      $('nameInput').value = user.username || user.email.split('@')[0];
    } else {
      $('nameInput').value = store.get('name') || '';
    }
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    // This click also counts as the user gesture browsers require before playing sound.
    myName = $('nameInput').value.trim() || 'Guest';
    store.set('name', myName);
    $('joinModal').hidden = true;
    connect();
  });

  function connect() {
    socket = io();
    socket.on('connect', () => {
      setConnStatus(null);
      socket.emit('room:join', { roomId, clientId, name: myName }, (res) => {
        if (!res?.ok) return fatal(res?.error || 'Could not join the room.');
        $('chatLog').replaceChildren();
        res.chat.forEach(addChatMessage);
        syncClock();
      });
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
    $('roomName').textContent = s.name;
    document.title = `${s.name} · 2Watch`;
    renderUsers();
    renderQueue();
    renderNowPlaying();
    renderControls();
    if ((s.media?.id ?? null) !== mountedId) mountMedia(s.media);
    syncTick();
  }

  function mountMedia(media) {
    if (adapter) {
      try { adapter.destroy(); } catch {}
    }
    adapter = null;
    adapterReady = false;
    lastSeekAt = 0;
    leadCheckAt = 0;
    lastDrift = null;
    pausedWhileWantedSince = 0;
    Object.assign(overlay, { error: null, blocked: false, loading: null, buffering: false });
    mountedId = media?.id ?? null;
    $('stageMedia').replaceChildren();
    $('stageEmpty').hidden = !!media;
    renderOverlay();
    if (!media) return;

    let a;
    try {
      const Adapter = Players.adapterFor(media.kind);
      a = new Adapter($('stageMedia'), media, {
        onMeta: (meta) => adapter === a && socket.emit('media:meta', { mediaId: media.id, ...meta }),
        onError: (msg) => {
          if (adapter !== a) return;
          overlay.error = msg;
          renderOverlay();
        },
        onBuffering: (b) => {
          if (adapter !== a) return;
          overlay.buffering = b;
          renderOverlay();
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
        if (adapter !== a) return;
        overlay.loading = null;
        overlay.error = err?.message || 'This video could not be loaded.';
        renderOverlay();
      });
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
    if (!a || !adapterReady || !playback || playback.mediaId !== mountedId || overlay.error) {
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
    const drift = current - target;
    lastDrift = drift;
    // Embeds take a moment to resume after a jump. Learn how long, so the next jump lands on target.
    if (leadCheckAt && now - leadCheckAt > 2000 && !overlay.buffering) {
      a.seekLead = clamp(a.seekLead - clamp(drift * 0.8, -0.5, 0.5), 0, 3);
      leadCheckAt = 0;
    }
    if (Math.abs(drift) > a.hardSyncThreshold) {
      if (now - lastSeekAt > 2500) {
        a.seek(target + a.seekLead);
        lastSeekAt = now;
        if (a.canRate) a.setRate(1);
        else leadCheckAt = now;
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
  $('uploadCancel').onclick = () => currentUpload?.abort();

  function startUpload(mode) {
    if (!selectedFile || currentUpload) return;
    const xhr = (currentUpload = new XMLHttpRequest());
    const fd = new FormData();
    fd.append('video', selectedFile);
    xhr.open('POST', `/api/rooms/${encodeURIComponent(roomId)}/upload?mode=${mode}`);
    xhr.setRequestHeader('X-Client-Id', clientId);

    $('uploadProgress').hidden = false;
    $('uploadNow').hidden = $('uploadQueue').hidden = true;
    const setProgress = (pct, text) => {
      $('uploadBar').style.width = pct + '%';
      $('uploadText').textContent = text;
    };
    setProgress(0, '0%');
    const started = performance.now();
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      const mbps = e.loaded / 1024 / 1024 / ((performance.now() - started) / 1000);
      setProgress(pct, pct >= 100 ? 'Processing…' : `${pct.toFixed(0)}% · ${mbps.toFixed(1)} MB/s`);
    };
    const done = (msg) => {
      currentUpload = null;
      $('uploadProgress').hidden = true;
      $('uploadNow').hidden = $('uploadQueue').hidden = false;
      if (msg) toast(msg);
    };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 400) return done(res.error || `Upload failed (${xhr.status}).`);
      selectedFile = null;
      $('fileInput').value = '';
      $('dzLabel').innerHTML = 'Drop a video here or <u>choose a file</u>';
      $('dzSub').textContent = 'MP4 (H.264/AAC) or WebM plays in every browser';
      done(mode === 'queue' ? 'Uploaded and added to the queue.' : 'Uploaded! Starting for everyone…');
      renderControls();
    };
    xhr.onerror = () => done('Upload failed. Check your connection.');
    xhr.onabort = () => done('Upload cancelled.');
    xhr.send(fd);
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
