# 2Watch

Watch videos together, in sync. Create a room, share the link, and play:

- **Uploaded video files**: stored on this server and streamed to everyone in the room.
- **YouTube, Facebook, Vimeo and Twitch links**: played directly from the platform. Nothing is downloaded or stored.
- **Direct video links** (`.mp4`, `.webm`, `.m3u8` HLS streams…): played from wherever they're hosted.

Everyone in a room sees the same moment of the video. A play, pause or seek by one person applies to everyone, and people who join late start at the current spot.

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, create a room and send the invite link to your friends.

## Accounts with Supabase (optional)

With Supabase set up, people create an account (display name, email, password) and must sign in before they can create or join a room. Their display name comes from their account. Without Supabase, people join by typing a name.

1. Create a free project at [supabase.com](https://supabase.com).
2. In **Settings → API**, copy the **Project URL** and the **anon public** key.
3. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
4. Restart the server.

Supabase only stores the accounts. Rooms, chat and uploaded videos stay on the computer running the server.

**Email confirmation.** By default Supabase emails new users a confirmation link, and they can sign in only after clicking it. Its built-in email service only sends a few emails per hour. For a small group of friends, you can turn this off in **Authentication → Sign In / Providers → Email → Confirm email**.

## Share it from your computer

`npm run share` starts the server and a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), then prints a public link such as `https://some-words.trycloudflare.com`. Send that link to your friends.

```bash
npm run share
```

- The server and everything it stores stay on your computer. Cloudflare only relays the traffic, over HTTPS, and WebSockets work through it.
- The link works only while that window is open and your computer is awake. Press `Ctrl+C` to stop sharing.
- The link changes every time you run `npm run share`. A permanent address needs a domain on Cloudflare and a named tunnel.
- Requires `cloudflared`. On Windows: `winget install --id Cloudflare.cloudflared`.
- Uploads travel over your home internet connection, so your upload speed limits how many people can stream an uploaded file smoothly. YouTube and other links aren't affected, because each viewer loads those from the platform.

## Run it on a server

To keep 2Watch online without your computer, run it on any always-on machine that runs Node.js, such as a VPS (DigitalOcean, Hetzner, Linode, AWS Lightsail…) or a Node host that keeps the process running, like Render or Fly.io. It can't run on serverless hosts such as Vercel or Netlify (see [Architecture](#architecture)).

### On Render

The repo includes a [`render.yaml`](render.yaml) Blueprint.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Choose **New → Blueprint**, pick this repository, and click **Connect**.
3. Enter `SUPABASE_URL` and `SUPABASE_ANON_KEY` when asked, then click **Apply**.
4. When the deploy finishes, your site is at the `https://….onrender.com` address shown on the service page. Every push to `main` redeploys it.

On the **free plan**, the service sleeps after 15 minutes without visitors. The next visit wakes it in about a minute, and sleeping clears any rooms and uploaded videos. Uploads are also cleared on every redeploy. A paid instance stays awake.

Render's Node environment doesn't include FFmpeg, and the free plan's 0.1 CPU is far too slow to encode video anyway, so [smooth mode](#smooth-mode-for-slow-connections) is off on Render. Use a VPS for that.

### On a Linux VPS

```bash
sudo apt install ffmpeg  # for smooth mode
git clone https://github.com/siamsayed67-beep/-2Watch.git 2watch
cd 2watch
npm install --omit=dev
cp .env.example .env     # then fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm start                # listens on PORT (default 3000)
```

For real use:

- **Keep it running** after you log out and after reboots, with a process manager such as `pm2` (`npm i -g pm2 && pm2 start server.js --name 2watch && pm2 save && pm2 startup`) or a systemd service.
- **Serve it over HTTPS** behind a reverse proxy such as Caddy or nginx. The proxy must pass WebSocket connections through, and must allow request bodies of at least 9 MB, because uploads arrive in 8 MB pieces (in nginx: `client_max_body_size 10m;`). Twitch embeds and clipboard copying need HTTPS.
- **Disk and bandwidth:** uploaded videos are stored in `uploads/` on the server and streamed to every viewer from it. Pick a plan with enough disk for your largest files and enough monthly traffic: one 2 GB video watched by 5 people uses about 10 GB.
- **Supabase:** if you keep email confirmation on, set **Authentication → URL Configuration → Site URL** to your server's address, so confirmation links lead back to your site.
- Restarting the server closes all rooms and clears `uploads/`.

## How the sync works

The **server owns the clock** for each room. It doesn't decode or send video frames. Instead, it records "at server time *T* the video was at position *P*, playing or paused". Every play, pause, seek and new video updates that record and is broadcast over WebSockets (Socket.IO).

Each browser:

1. **Measures its clock offset** from the server (like NTP: several round trips, keeping the fastest) so it knows the server's "now" to within a few milliseconds.
2. **Calculates where the video should be right now**: `P + (serverNow − T)`.
3. **Corrects its player 4 times a second:**
   - Uploaded files and direct links: small drift is fixed by briefly playing at 0.9–1.1× speed, which you can't notice. Large drift is fixed by jumping, but only to a moment that's already downloaded. Jumping into a part that hasn't loaded yet would just cause another pause, so a viewer who fell behind while loading catches up gradually instead.
   - YouTube, Vimeo, Facebook and Twitch embeds can't change speed smoothly, so they jump to the right spot. Each player learns how long its seeks take, so the jumps land on target.
4. New videos start **1.5 s in the future** (with a countdown) so every viewer has the video loaded when it begins.
5. The server detects when a video has finished and automatically starts the next one in the queue.

Measured in local testing with two browsers:

| Source | Viewers' distance from the room clock |
| --- | --- |
| Uploaded MP4 | 1–12 ms |
| YouTube | ~20–45 ms after settling (a few seconds after a start or seek) |

Each viewer's sync status is shown under the player ("In sync (±20 ms)").

## Uploads vs links

- **Uploads** go to temporary storage, served with HTTP range requests, so viewers can start anywhere in the file without downloading it all. A file is deleted when it's replaced, skipped or removed from the queue, or when its room closes. MP4 (H.264 + AAC) and WebM play in every browser. Other formats (MKV, AVI, MPEG-2…) play through [smooth mode](#smooth-mode-for-slow-connections) when FFmpeg is installed.
- **Links** are never fetched by the server. Each viewer's browser loads the official embedded player (YouTube IFrame API, Facebook embedded video player, Vimeo Player SDK, Twitch embed), and the sync engine controls it. This is also the only way that complies with these platforms' terms.

## Smooth mode (for slow connections)

A video needs a certain amount of data per second. A 4 GB, 2-hour movie needs about 4.5 Mbit/s. A viewer whose connection is slower than that can't download the video as fast as it plays, so it keeps pausing, while the uploader (usually on the same machine as the server) has no problem. When the server runs on a home computer, every viewer's copy also comes out of that home connection's upload speed.

So when FFmpeg is installed, the server also makes **lower-quality copies** of each upload (720p, 480p and 360p, below the original's resolution), cut into 4-second segments (HLS):

- **Everyone starts on the original.** Viewers whose video pauses to load twice within a minute, or once for more than 3 seconds, are switched to smooth mode automatically. There, the player picks the best quality their connection can sustain and keeps 1–2 minutes loaded ahead. Anyone can also switch with the **"Lagging? Use smooth mode"** button under the player.
- **It's available seconds after an upload.** Segments are published as they're encoded, and encoding runs several times faster than playback. On a Ryzen 5 5600, a 2-hour 1080p movie takes about 19 minutes in total. Viewers are only switched once the encoded part is safely ahead of the room.
- **Files a browser can't play** (MPEG-2, some MKV/AVI) are converted the same way and start playing automatically.
- **Disk space:** the copies take roughly as much space again as the original, and are deleted with it.

Measured with one viewer's connection limited to below the video's data rate (a 5.1 Mbit/s, 1080p test video):

| Slow viewer's connection | Without smooth mode | With smooth mode |
| --- | --- | --- |
| 4 Mbit/s | stuck loading 59 s out of 90 s, with 32 forced jumps | about 3 s of pauses in total, all in the first ~15 s, settles on 480p |
| 2 Mbit/s | unwatchable | about 3–4 s of pauses in total, all in the first ~17 s, settles on 360p |
| 10 Mbit/s | smooth | stays on the original, no pauses |

FFmpeg is found automatically on the `PATH` (and, on Windows, where `winget install Gyan.FFmpeg` puts it). Otherwise set `FFMPEG_PATH` and `FFPROBE_PATH`. Without FFmpeg, uploads play in their original quality only.

## Voice chat

Everyone who joins a room is in its voice chat automatically. The browser asks for microphone permission once.

- **Low delay:** voices go directly between viewers' browsers (WebRTC, Opus codec), not through the server, so the delay is only the network distance between people, typically 0.1–0.3 s. Echo cancellation, noise suppression and automatic volume levelling are on.
- **Mute** with the **Mute mic** button under "Watching now", or the **V** key. Your choice is remembered. Everyone sees who's in voice, who's muted (red mic) and who's talking (green ring).
- **No microphone, or permission refused:** you can still hear everyone. If you blocked the microphone, allow it in the address bar and press **Allow mic**.
- Use **headphones**: otherwise the video's sound from your speakers can reach the others through your microphone.
- Microphones only work on **https** links (or `localhost`): the Cloudflare tunnel, Render and HTTPS servers are fine.
- Everyone connects to everyone, which works well for up to about 8 people in voice.
- A few strict networks (some offices and mobile carriers) block direct connections. For those, add a TURN relay server in `.env` (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`). The voice audio of those viewers then goes through the relay.

## Rooms and permissions

- The person who creates a room is the **host**. If the host leaves for more than 20 s, the host role passes to someone else.
- By default **everyone can control** playback and add videos. The host can switch the room to host-only.
- The room includes a **queue** ("Add to queue"), a **chat** that also logs who paused or skipped, and a viewer list.
- Keyboard shortcuts: `Space`/`K` play/pause, `←`/`→` ±10 s, `F` fullscreen, `M` mute the video, `V` mute your microphone.

## Platform notes

- **YouTube**: the video owner must allow embedding. Otherwise the player shows a clear error and you can skip to the next video.
- **Facebook**: only **public** videos can be embedded. Use the full video URL (`facebook.com/.../videos/...` or `/watch/?v=...`). Some `fb.watch` short links don't work in the embedded player.
- **Twitch**: past broadcasts (`twitch.tv/videos/...`) are fully synced. Live channels sync play/pause only, since a live stream is already "now" for everyone. Twitch requires the site to be served over **HTTPS** (or `localhost`).
- Live streams in general (YouTube live, live HLS) show **LIVE** and only sync play/pause.
- Browsers block sound until the viewer has clicked something. The "Join the room" button covers this, and if a browser still blocks playback, viewers see a "Click to start playback" prompt.

## Architecture

- **Frontend:** HTML/CSS/JavaScript + Socket.IO client
- **Backend:** Node.js (Express.js) + Socket.IO server
- **Hosting:** any always-on Node.js machine: your own computer (shared through a Cloudflare tunnel) or a server
- **Video storage:** the `uploads/` folder next to `server.js`, deleted when a video is replaced or its room closes
- **User accounts:** Supabase (optional)
- **Real-time sync:** WebSockets via Socket.IO

The server must keep running between requests, because rooms and the sync clock live in its memory and viewers keep a WebSocket open. That's why serverless hosts such as Vercel or Netlify can't run it.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | (unset) | Supabase project URL (optional) |
| `SUPABASE_ANON_KEY` | (unset) | Supabase anon public key (optional) |
| `PORT` | `3000` | Port to listen on |
| `MAX_UPLOAD_MB` | `16384` | Largest file someone can upload, in MB (16 GB) |
| `ROOM_IDLE_MINUTES` | `30` | Empty rooms are deleted after this long |
| `CLOUDFLARED_PATH` | (auto) | Path to `cloudflared.exe`, if `npm run share` can't find it |
| `FFMPEG_PATH`, `FFPROBE_PATH` | (auto) | Paths to FFmpeg and FFprobe for smooth mode, if they aren't found automatically |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | (unset) | Optional TURN relay for voice chat on networks that block direct connections |

All environment variables go in `.env`, which git ignores, so it's never uploaded to GitHub.

## Security

- `.env` holds your Supabase settings and is never committed. `.env.example` has placeholders only.
- The Supabase anon key is sent to the browser, which is how Supabase is designed to work. It doesn't give access beyond what your Supabase project allows.
- Rooms and chat live in memory and disappear when the server stops.

## License

MIT
