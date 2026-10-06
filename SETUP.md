# 2Watch Setup Guide with Supabase Authentication

This guide will help you set up 2Watch with Supabase authentication so people can create accounts and share rooms.

## What You'll Have

- **Local server on your device** storing all video uploads and room data (nothing goes to Supabase)
- **Supabase handles authentication** - users create accounts and sign in
- **Shareable website** - send people a link to join and watch together

## Prerequisites

- Node.js 18+ (check with `node -v`)
- A free [Supabase](https://supabase.com) account

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Click **"Sign up"** and create an account
3. Click **"New Project"** and fill in:
   - **Name**: `2watch` (or whatever you like)
   - **Database Password**: Create a secure password
   - **Region**: Choose the closest to you
4. Click **"Create new project"** and wait a few minutes for it to initialize

## Step 2: Get Your Supabase Keys

1. In Supabase, go to **Settings** (⚙️ icon, bottom left)
2. Click **API** in the left sidebar
3. You'll see two important values:
   - **Project URL** (starts with `https://`)
   - **Anon public** key (a long string)

Copy both of these.

## Step 3: Configure 2Watch

1. In the 2Watch folder, create a file called `.env`:
   ```
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_ANON_KEY=your-anon-key-here
   PORT=3000
   MAX_UPLOAD_MB=4096
   ROOM_IDLE_MINUTES=30
   ```

2. Replace:
   - `https://your-project-id.supabase.co` with your **Project URL**
   - `your-anon-key-here` with your **Anon public** key

3. Save the file

## Step 4: Run the Server

```bash
cd path/to/2Watch
npm install
npm start
```

You should see:
```
2Watch running at http://localhost:3000
```

## Step 5: Share Your Website

Now you can share **http://localhost:3000** with friends, but they need access to your computer. To share over the internet, use:

### Option A: Ngrok Tunnel (Easiest)

1. Download [ngrok](https://ngrok.com) and sign up (free)
2. Run:
   ```bash
   ngrok http 3000
   ```
3. Ngrok will give you a URL like `https://abc123.ngrok.io`
4. Share that URL with your friends

### Option B: Deploy to a Server

For permanent sharing, host 2Watch on a cloud server:
- **Heroku** (free tier limited)
- **Railway** ($5/month)
- **DigitalOcean** ($5/month)
- **Linode** ($5/month)

Each has different deployment steps, but the idea is the same: push your code and it runs there instead of your laptop.

### Option C: CloudFlare Tunnel (No Account Needed)

1. Install [CloudFlare Tunnel CLI](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/tunnel-guide/remote/)
2. Run:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

## How It Works

### With Supabase Auth Enabled:

1. **You open** http://localhost:3000 → see "Sign in" / "Create account"
2. **You sign up** → Supabase stores your account
3. **You create a room** → stored on your local server
4. **You share the link** → friends sign up, join your room
5. **Everyone watches together** → your local server syncs playback

### What's Where:

| What | Where |
| --- | --- |
| User accounts | Supabase cloud (encrypted passwords, emails) |
| Room data | Your local device (in memory) |
| Video uploads | Your local device (in `uploads/` folder) |
| Chat messages | Your local device (in memory, deleted when room closes) |
| Playback sync | Your local server |

### What If I Don't Use Supabase?

The server still works without `.env` credentials:
- People just type a name to join (no accounts)
- Everything else works the same
- But you can't easily identify who's who or have user profiles

## Troubleshooting

### "Cannot find module '@supabase/supabase-js'"
Run `npm install` again in the 2Watch directory.

### "Server won't start"
Check `.env` for syntax errors. It should be:
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=xxxxx
```
No quotes needed.

### "Auth modal won't go away"
If you see "Please add Supabase credentials to .env first", your `.env` file isn't being read. Make sure it's in the 2Watch root directory (same folder as `package.json`).

### "Friend can't join"
- Make sure they can reach your URL (ngrok, tunnel, or deployed server)
- They need to sign up first if auth is enabled
- The room code is case-sensitive (e.g., `k7m2qp` not `K7M2QP`)

## What's Next?

- [Customize the look](README.md#styling)
- [Set up a custom domain](#) (optional)
- [Deploy permanently](#option-b-deploy-to-a-server)

## Questions?

Check the [main README](README.md) for more details on how the sync engine works, platform support, and deployment options.
