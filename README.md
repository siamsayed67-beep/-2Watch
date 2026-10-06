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

## Setup Supabase (optional - for user accounts)

If you want people to create accounts instead of just typing a name:

1. Go to [supabase.com](https://supabase.com) and create a free project
2. In **Settings → API**, copy:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
3. Create `.env` in this directory:
   ```
   SUPABASE_URL=your-url-here
   SUPABASE_ANON_KEY=your-key-here
   PORT=3000
   MAX_UPLOAD_MB=4096
   ROOM_IDLE_MINUTES=30
   ```
4. Restart the server

**Without Supabase:** 2Watch works fine. People just type a name to join.

## Deploy to Vercel (everyone can access)

**See [VERCEL_DEPLOY.md](VERCEL_DEPLOY.md) for step-by-step instructions.**

Quick version:
1. Push to GitHub
2. Connect to [vercel.com](https://vercel.com)
3. Add Supabase credentials as environment variables
4. Done! Vercel auto-deploys every time you push

**Cost:** Free (Vercel free tier + Supabase free tier)

## How the sync works

The **server owns the clock** for each room. It doesn't decode or send video frames. Instead, it records "at server time *T* the video was at position *P*, playing or paused". Every play, pause, seek and new video updates that record and is broadcast over WebSockets (Socket.IO).

Each browser:

1. **Measures its clock offset** from the server (like NTP: several round trips, keeping the fastest) so it knows the server's "now" to within a few milliseconds.
2. **Calculates where the video should be right now**: `P + (serverNow − T)`.
3. **Corrects its player 4 times a second:**
   - Uploaded files and direct links: small drift is fixed by briefly playing at 0.9–1.1× speed, which you can't notice. Large drift is fixed by jumping.
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

- **Uploads** go to temporary storage, served with HTTP range requests, so viewers can start anywhere in the file without downloading it all. A file is deleted when it's replaced, skipped or removed from the queue, or when its room closes. MP4 (H.264 + AAC) and WebM play in every browser. MKV/AVI or HEVC files may not play, because the server doesn't re-encode video.
- **Links** are never fetched by the server. Each viewer's browser loads the official embedded player (YouTube IFrame API, Facebook embedded video player, Vimeo Player SDK, Twitch embed), and the sync engine controls it. This is also the only way that complies with these platforms' terms.

## Rooms and permissions

- The person who creates a room is the **host**. If the host leaves for more than 20 s, the host role passes to someone else.
- By default **everyone can control** playback and add videos. The host can switch the room to host-only.
- The room includes a **queue** ("Add to queue"), a **chat** that also logs who paused or skipped, and a viewer list.
- Keyboard shortcuts: `Space`/`K` play/pause, `←`/`→` ±10 s, `F` fullscreen, `M` mute.

## Platform notes

- **YouTube**: the video owner must allow embedding. Otherwise the player shows a clear error and you can skip to the next video.
- **Facebook**: only **public** videos can be embedded. Use the full video URL (`facebook.com/.../videos/...` or `/watch/?v=...`). Some `fb.watch` short links don't work in the embedded player.
- **Twitch**: past broadcasts (`twitch.tv/videos/...`) are fully synced. Live channels sync play/pause only, since a live stream is already "now" for everyone. Twitch requires the site to be served over **HTTPS** (or `localhost`).
- Live streams in general (YouTube live, live HLS) show **LIVE** and only sync play/pause.
- Browsers block sound until the viewer has clicked something. The "Join the room" button covers this, and if a browser still blocks playback, viewers see a "Click to start playback" prompt.

## Architecture

- **Frontend:** HTML/CSS/JavaScript + Socket.IO client
- **Backend:** Node.js (Express.js) + Socket.IO server
- **Hosting:** Vercel (full-stack Node.js)
- **Video storage:** Ephemeral (temporary during streaming)
- **User accounts:** Supabase (optional)
- **Real-time sync:** WebSockets via Socket.IO ✅

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | (unset) | Supabase project URL (optional) |
| `SUPABASE_ANON_KEY` | (unset) | Supabase anon public key (optional) |
| `PORT` | `3000` | Port to listen on |
| `MAX_UPLOAD_MB` | `4096` | Largest file someone can upload |
| `ROOM_IDLE_MINUTES` | `30` | Empty rooms are deleted after this long |

All environment variables go in `.env` (not committed to git). On Vercel, add them in the dashboard.

## Security

- ✅ Supabase credentials are **never committed to git** (in .gitignore)
- ✅ Only `.env.example` is pushed (template with placeholders)
- ✅ Each deployment has its own isolated environment on Vercel
- ✅ Rooms and chat are ephemeral (deleted when empty or server restarts)

## License

MIT
