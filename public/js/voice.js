'use strict';

/*
 * Voice chat for a room. Audio travels directly between browsers (WebRTC with the Opus codec),
 * not through the server, so the delay is only the network distance between people, usually
 * a fraction of a second. The browser's echo cancellation, noise suppression and automatic
 * gain are switched on. Everyone connects to everyone else, which suits watch parties of up
 * to about 8 people.
 *
 * The server only introduces participants: it says who is already in voice and passes the
 * connection details between them (see "voice:*" events in server.js).
 */
window.VoiceChat = class VoiceChat {
  constructor({ socket, iceServers, onChange }) {
    this.socket = socket;
    this.iceServers = iceServers || [];
    this.onChange = onChange || (() => {});
    this.peers = new Map(); // socket id -> { id, clientId, name, pc, pending, audio }
    this.stream = null; // our microphone
    this.micError = null; // 'blocked' | 'nomic' | 'insecure' | 'unavailable'
    this.muted = false;
    this.joined = false;
    this.needsClick = false; // the browser blocked playing others' voices until a click
    this.speaking = new Set(); // client ids talking right now ('self' for us)
    this.ctx = null;
    this.levels = new Map(); // 'self' or socket id -> analyser

    socket.on('voice:peer-joined', (p) => this.addPeer(p, false));
    socket.on('voice:peer-left', ({ id }) => this.removePeer(id));
    socket.on('voice:signal', (m) => this.onSignal(m));
    this.levelTimer = setInterval(() => this.checkLevels(), 150);
  }

  async start(muted) {
    this.muted = !!muted;
    await this.openMic();
    this.join();
  }

  async openMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micError = window.isSecureContext ? 'unavailable' : 'insecure';
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micError = null;
      for (const t of this.stream.getAudioTracks()) t.enabled = !this.muted;
      this.watchLevel('self', this.stream);
    } catch (err) {
      this.stream = null;
      this.micError = err.name === 'NotAllowedError' ? 'blocked' : err.name === 'NotFoundError' ? 'nomic' : 'unavailable';
    }
  }

  /** Enters voice (again): drops any old connections and connects to everyone in voice. */
  join() {
    this.closeAll();
    this.socket.emit('voice:join', { muted: this.muted, hasMic: !!this.stream }, (res) => {
      if (!res?.ok) return;
      this.joined = true;
      for (const p of res.peers) this.addPeer(p, true);
      this.changed();
    });
  }

  /** After a reconnect (e.g. the server restarted), the server has forgotten us: join again. */
  rejoin() {
    this.join();
  }

  /** The user allowed the microphone after first blocking it. */
  async retryMic() {
    await this.openMic();
    if (this.stream) this.join(); // reconnect so everyone receives our new audio
    this.changed();
  }

  setMuted(muted) {
    this.muted = !!muted;
    // Disabling the track sends silence immediately, without renegotiating any connection.
    for (const t of this.stream?.getAudioTracks() || []) t.enabled = !this.muted;
    this.socket.emit('voice:mute', { muted: this.muted });
    this.changed();
  }

  /** Plays others' voices after a click, if the browser blocked it before. */
  unlockAudio() {
    this.needsClick = false;
    this.ctx?.resume().catch(() => {});
    for (const p of this.peers.values()) p.audio?.play().catch(() => {});
    this.changed();
  }

  addPeer({ id, clientId, name }, initiator) {
    const existing = this.peers.get(id);
    if (existing) {
      existing.clientId ||= clientId;
      existing.name ||= name;
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { id, clientId, name, pc, pending: [], audio: null };
    this.peers.set(id, peer);

    if (this.stream) for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
    else pc.addTransceiver('audio', { direction: 'recvonly' }); // no mic: listen only

    pc.onicecandidate = (e) => e.candidate && this.signal(id, { candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!peer.audio) {
        peer.audio = new Audio();
        peer.audio.autoplay = true;
      }
      peer.audio.srcObject = stream;
      peer.audio.play().catch(() => {
        this.needsClick = true;
        this.changed();
      });
      this.watchLevel(id, stream);
    };
    pc.onconnectionstatechange = () => {
      // A broken route (e.g. a network change): the side that started the call tries again.
      if (pc.connectionState === 'failed' && initiator) this.offer(peer, true);
      this.changed();
    };
    if (initiator) this.offer(peer);
    this.changed();
    return peer;
  }

  async offer(peer, iceRestart = false) {
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
      this.signal(peer.id, { sdp: peer.pc.localDescription.toJSON() });
    } catch (err) {
      console.warn('Voice: could not start a connection', err);
    }
  }

  async onSignal({ from, data }) {
    const peer = this.peers.get(from) || this.addPeer({ id: from }, false);
    const pc = peer.pc;
    try {
      if (data?.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal(from, { sdp: pc.localDescription.toJSON() });
        }
        // Network candidates that arrived before the offer/answer.
        for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data?.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (err) {
      console.warn('Voice: connection setup failed', err);
    }
  }

  signal(to, data) {
    this.socket.emit('voice:signal', { to, data });
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.levels.delete(id);
    try { peer.pc.close(); } catch {}
    if (peer.audio) {
      peer.audio.pause();
      peer.audio.srcObject = null;
    }
    this.changed();
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  // Speaking indicators: measures each voice's loudness a few times a second.
  watchLevel(key, stream) {
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume().catch(() => {});
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      this.levels.set(key, { analyser, buf: new Float32Array(analyser.fftSize) });
    } catch {}
  }

  checkLevels() {
    const speaking = new Set();
    for (const [key, { analyser, buf }] of this.levels) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      if (Math.sqrt(sum / buf.length) < 0.02) continue;
      if (key === 'self') {
        if (!this.muted) speaking.add('self');
      } else {
        const p = this.peers.get(key);
        if (p?.clientId) speaking.add(p.clientId);
      }
    }
    if (speaking.size !== this.speaking.size || [...speaking].some((k) => !this.speaking.has(k))) {
      this.speaking = speaking;
      this.changed();
    }
  }

  summary() {
    const peers = [...this.peers.values()];
    return {
      joined: this.joined,
      muted: this.muted,
      hasMic: !!this.stream,
      micError: this.micError,
      needsClick: this.needsClick,
      total: peers.length,
      connected: peers.filter((p) => p.pc.connectionState === 'connected').length,
    };
  }

  changed() {
    this.onChange(this.summary());
  }
};
