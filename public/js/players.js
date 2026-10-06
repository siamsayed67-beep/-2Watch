'use strict';

/*
 * Player adapters. Every source (uploaded file, YouTube, Facebook, Vimeo, Twitch, direct link)
 * is wrapped in the same interface so the sync engine in room.js can drive any of them:
 *
 *   ready            Promise that resolves once the player can be controlled
 *   play()           may return a Promise (rejects with NotAllowedError if autoplay is blocked)
 *   pause(), seek(seconds), getTime(), getDuration(), isPaused()
 *   setVolume(0..1), setMuted(bool), destroy()
 *   canRate / setRate(r)   smooth drift correction by nudging playback speed (HTML5 only)
 *   hardSyncThreshold      drift (seconds) after which we jump instead of nudging
 *   seekLead               seconds to aim ahead when jumping, to cover the embed's seek delay
 *   live                   true for live streams (no seeking, only play/pause is synced)
 */
window.Players = (() => {
  const FB_SDK_VERSION = 'v23.0';
  const scripts = {};

  function loadScript(src) {
    return (scripts[src] ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        delete scripts[src];
        reject(new Error(`Could not load ${new URL(src).hostname}. Check your connection or ad blocker.`));
      };
      document.head.appendChild(s);
    }));
  }

  let ytApi;
  function loadYouTubeApi() {
    return (ytApi ||= new Promise((resolve, reject) => {
      if (window.YT?.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      loadScript('https://www.youtube.com/iframe_api').catch((e) => {
        ytApi = null;
        reject(e);
      });
    }));
  }

  let fbSdk;
  function loadFacebookSdk() {
    return (fbSdk ||= new Promise((resolve, reject) => {
      if (window.FB) return resolve();
      window.fbAsyncInit = () => {
        FB.init({ xfbml: false, version: FB_SDK_VERSION });
        resolve();
      };
      loadScript('https://connect.facebook.net/en_US/sdk.js').catch((e) => {
        fbSdk = null;
        reject(e);
      });
    }));
  }

  /* ------------------------------------------------- uploaded files & direct links */

  function html5ErrorMessage(err) {
    if (err?.code === 4) {
      return "Your browser can't play this file format. MP4 (H.264 + AAC) or WebM files work everywhere.";
    }
    if (err?.code === 2) return 'A network error interrupted the video.';
    return 'This video could not be played.';
  }

  class Html5Adapter {
    constructor(container, media, ev) {
      this.canRate = true;
      this.hardSyncThreshold = 1;
      this.seekLead = 0;
      this.live = false;

      const v = (this.video = document.createElement('video'));
      v.playsInline = true;
      v.preload = 'auto';
      v.controls = false;
      container.appendChild(v);

      v.addEventListener('waiting', () => ev.onBuffering(true));
      v.addEventListener('playing', () => ev.onBuffering(false));
      v.addEventListener('canplay', () => ev.onBuffering(false));

      let fail;
      const loaded = new Promise((resolve, reject) => {
        fail = reject;
        v.addEventListener(
          'loadedmetadata',
          () => {
            this.live = v.duration === Infinity;
            ev.onMeta(this.live ? { live: true } : { duration: v.duration });
            resolve();
          },
          { once: true },
        );
      });
      v.addEventListener('error', () => {
        const msg = html5ErrorMessage(v.error);
        fail(new Error(msg));
        ev.onError(msg);
      });

      const isHls = media.hls || /\.m3u8(\?|$)/i.test(media.src);
      const attach = () => {
        if (isHls && !v.canPlayType('application/vnd.apple.mpegurl')) {
          return loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
            if (!window.Hls?.isSupported()) throw new Error("This browser can't play HLS streams.");
            this.hls = new Hls();
            this.hls.on(Hls.Events.ERROR, (e, data) => {
              if (data.fatal) {
                fail(new Error('The stream could not be loaded.'));
                ev.onError('The stream could not be loaded.');
              }
            });
            this.hls.loadSource(media.src);
            this.hls.attachMedia(v);
          });
        }
        v.src = media.src;
        return Promise.resolve();
      };
      this.ready = attach().then(() => loaded);
    }
    play() { return this.video.play(); }
    pause() { this.video.pause(); }
    seek(t) { this.video.currentTime = t; }
    getTime() { return this.video.currentTime; }
    getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }
    isPaused() { return this.video.paused; }
    setRate(r) { if (Math.abs(this.video.playbackRate - r) > 0.005) this.video.playbackRate = r; }
    setVolume(v) { this.video.volume = v; }
    setMuted(m) { this.video.muted = m; }
    destroy() {
      this.hls?.destroy();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
    }
  }

  /* ------------------------------------------------------------------ YouTube */

  const YT_ERRORS = {
    2: 'That YouTube link is invalid.',
    5: "YouTube couldn't play this video in the browser.",
    100: 'This YouTube video was removed or is private.',
    101: "The video's owner doesn't allow it to be played on other websites.",
    150: "The video's owner doesn't allow it to be played on other websites.",
  };

  class YouTubeAdapter {
    constructor(container, media, ev) {
      this.canRate = false;
      this.hardSyncThreshold = 0.35;
      this.seekLead = 0.3;
      this.live = false;
      let reported = false;
      const report = () => {
        const p = this.player;
        const data = p.getVideoData?.() || {};
        this.live = !!data.isLive;
        const d = p.getDuration();
        if (this.live) ev.onMeta({ live: true, title: data.title });
        else if (d > 0) ev.onMeta({ duration: d, title: data.title });
        else return;
        reported = true;
      };

      const el = document.createElement('div');
      container.appendChild(el);
      this.ready = loadYouTubeApi().then(
        () =>
          new Promise((resolve) => {
            this.player = new YT.Player(el, {
              videoId: media.videoId,
              width: '100%',
              height: '100%',
              playerVars: {
                controls: 0,
                disablekb: 1,
                fs: 0,
                rel: 0,
                playsinline: 1,
                iv_load_policy: 3,
                origin: location.origin,
              },
              events: {
                onReady: () => {
                  report();
                  // The iframe only reports its time every ~250 ms. Watch for each new report
                  // so getTime() can extrapolate from the moment it arrived.
                  this.poll = setInterval(() => {
                    const t = this.player.getCurrentTime?.() || 0;
                    if (t !== this.lastT) {
                      this.lastT = t;
                      this.lastAt = performance.now();
                    }
                  }, 30);
                  resolve();
                },
                onStateChange: (e) => {
                  ev.onBuffering(e.data === YT.PlayerState.BUFFERING);
                  if (!reported) report();
                },
                onError: (e) => ev.onError(YT_ERRORS[e.data] || `YouTube error ${e.data}.`),
              },
            });
          }),
      );
    }
    play() { this.player.playVideo(); }
    pause() { this.player.pauseVideo(); }
    seek(t) {
      this.player.seekTo(t, true);
      this.lastT = undefined;
    }
    getTime() {
      const t = this.player.getCurrentTime() || 0;
      if (t !== this.lastT || this.player.getPlayerState() !== YT.PlayerState.PLAYING) return t;
      return t + Math.min(0.5, (performance.now() - this.lastAt) / 1000);
    }
    getDuration() { return this.player.getDuration() || 0; }
    isPaused() {
      const s = this.player.getPlayerState();
      return s !== YT.PlayerState.PLAYING && s !== YT.PlayerState.BUFFERING;
    }
    setVolume(v) { this.player.setVolume(Math.round(v * 100)); }
    setMuted(m) { m ? this.player.mute() : this.player.unMute(); }
    destroy() {
      clearInterval(this.poll);
      this.player?.destroy();
    }
  }

  /* ----------------------------------------------------------------- Facebook */

  class FacebookAdapter {
    constructor(container, media, ev) {
      this.canRate = false;
      this.hardSyncThreshold = 0.8;
      this.seekLead = 0.5;
      this.live = false;
      this.paused = true;
      this.subs = [];

      const id = 'fbv-' + Math.random().toString(36).slice(2);
      const el = document.createElement('div');
      el.className = 'fb-video';
      el.id = id;
      el.dataset.href = media.src;
      el.dataset.width = String(Math.max(320, Math.floor(container.clientWidth)));
      el.dataset.allowfullscreen = 'false';
      el.dataset.autoplay = 'false';
      el.dataset.showText = 'false';
      el.dataset.showCaptions = 'false';
      container.appendChild(el);

      this.ready = loadFacebookSdk().then(
        () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              FB.Event.unsubscribe('xfbml.ready', onReady);
              reject(new Error('Facebook did not load this video. Only public videos can be embedded.'));
            }, 20000);
            const onReady = (msg) => {
              if (msg.type !== 'video' || msg.id !== id) return;
              clearTimeout(timer);
              FB.Event.unsubscribe('xfbml.ready', onReady);
              const p = (this.player = msg.instance);
              const sub = (name, fn) => this.subs.push([p.subscribe(name, fn), name]);
              const reportDuration = () => {
                const d = p.getDuration();
                if (d > 0) ev.onMeta({ duration: d });
              };
              sub('startedPlaying', () => { this.paused = false; reportDuration(); });
              sub('paused', () => { this.paused = true; });
              sub('finishedPlaying', () => { this.paused = true; });
              sub('startedBuffering', () => ev.onBuffering(true));
              sub('finishedBuffering', () => ev.onBuffering(false));
              sub('error', () => ev.onError('Facebook could not play this video.'));
              reportDuration();
              resolve();
            };
            FB.Event.subscribe('xfbml.ready', onReady);
            FB.XFBML.parse(container);
          }),
      );
    }
    play() { this.player.play(); }
    pause() { this.player.pause(); }
    seek(t) { this.player.seek(t); }
    getTime() { return this.player.getCurrentPosition() || 0; }
    getDuration() { return this.player.getDuration() || 0; }
    isPaused() { return this.paused; }
    setVolume(v) { this.player.setVolume(v); }
    setMuted(m) { m ? this.player.mute() : this.player.unmute(); }
    destroy() {
      for (const [token, name] of this.subs) {
        try { token.release(name); } catch {}
      }
    }
  }

  /* -------------------------------------------------------------------- Vimeo */

  class VimeoAdapter {
    constructor(container, media, ev) {
      this.canRate = false;
      this.hardSyncThreshold = 0.35;
      this.seekLead = 0.3;
      this.live = false;
      this.paused = true;
      this.t = 0;
      this.tAt = performance.now();
      this.dur = 0;

      const el = document.createElement('div');
      el.className = 'vimeo-host';
      container.appendChild(el);
      this.ready = loadScript('https://player.vimeo.com/api/player.js').then(() => {
        const p = (this.player = new Vimeo.Player(el, {
          url: media.src,
          controls: false,
          playsinline: true,
          dnt: true,
          keyboard: false,
        }));
        // Vimeo's API is async, so keep a locally extrapolated clock for the sync loop.
        const mark = (sec) => { this.t = sec; this.tAt = performance.now(); };
        p.on('timeupdate', (d) => { mark(d.seconds); this.dur = d.duration; });
        p.on('seeked', (d) => mark(d.seconds));
        p.on('play', () => { this.paused = false; });
        p.on('pause', (d) => { this.paused = true; mark(d.seconds); });
        p.on('ended', () => { this.paused = true; });
        p.on('bufferstart', () => ev.onBuffering(true));
        p.on('bufferend', () => ev.onBuffering(false));
        p.on('error', (e) => ev.onError(e?.message || 'Vimeo could not play this video.'));
        return p.ready().then(() =>
          Promise.all([p.getDuration(), p.getVideoTitle().catch(() => '')]).then(([d, title]) => {
            this.dur = d;
            ev.onMeta({ duration: d, title });
          }),
        );
      });
    }
    play() { return this.player.play(); }
    pause() { this.player.pause().catch(() => {}); }
    seek(t) {
      this.t = t;
      this.tAt = performance.now();
      this.player.setCurrentTime(t).catch(() => {});
    }
    getTime() { return this.paused ? this.t : this.t + (performance.now() - this.tAt) / 1000; }
    getDuration() { return this.dur; }
    isPaused() { return this.paused; }
    setVolume(v) { this.player.setVolume(v).catch(() => {}); }
    setMuted(m) { this.player.setMuted(m).catch(() => {}); }
    destroy() { this.player?.destroy().catch(() => {}); }
  }

  /* ------------------------------------------------------------------- Twitch */

  class TwitchAdapter {
    constructor(container, media, ev) {
      this.canRate = false;
      this.hardSyncThreshold = 0.8;
      this.seekLead = 0.5;
      this.live = !!media.channel;

      const el = document.createElement('div');
      el.id = 'tw-' + Math.random().toString(36).slice(2);
      container.appendChild(el);
      this.ready = loadScript('https://player.twitch.tv/js/embed/v1.js').then(
        () =>
          new Promise((resolve) => {
            const opts = { width: '100%', height: '100%', parent: [location.hostname], autoplay: false };
            if (media.channel) opts.channel = media.channel;
            else opts.video = media.videoId;
            const p = (this.player = new Twitch.Player(el.id, opts));
            p.addEventListener(Twitch.Player.READY, () => {
              const d = p.getDuration();
              ev.onMeta(this.live ? { live: true } : d > 0 ? { duration: d } : {});
              resolve();
            });
            p.addEventListener(Twitch.Player.PLAYING, () => {
              ev.onBuffering(false);
              const d = p.getDuration();
              if (!this.live && d > 0) ev.onMeta({ duration: d });
            });
          }),
      );
    }
    play() { this.player.play(); }
    pause() { this.player.pause(); }
    seek(t) { this.player.seek(t); }
    getTime() { return this.player.getCurrentTime() || 0; }
    getDuration() { return this.player.getDuration() || 0; }
    isPaused() { return this.player.isPaused(); }
    setVolume(v) { this.player.setVolume(v); }
    setMuted(m) { this.player.setMuted(m); }
    destroy() {}
  }

  const byKind = {
    file: Html5Adapter,
    direct: Html5Adapter,
    youtube: YouTubeAdapter,
    facebook: FacebookAdapter,
    vimeo: VimeoAdapter,
    twitch: TwitchAdapter,
  };

  return {
    adapterFor(kind) {
      const A = byKind[kind];
      if (!A) throw new Error(`Unsupported source: ${kind}`);
      return A;
    },
  };
})();
