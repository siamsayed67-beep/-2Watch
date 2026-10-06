# Deploy 2Watch to Railway

Railway is the easiest way to deploy 2Watch. It costs **$5/month** and handles everything automatically.

## Prerequisites

- GitHub account (free at [github.com](https://github.com))
- Railway account (free at [railway.app](https://railway.app))
- Git installed on your machine

## Step 1: Create a GitHub Repository

### Option A: Using Git CLI (Recommended)

```bash
cd D:\Claude\2Watch
git init
git add .
git commit -m "Initial 2Watch commit"
```

Then create a new repository on GitHub:
1. Go to [github.com/new](https://github.com/new)
2. Name it `2watch` (or whatever you like)
3. Click **"Create repository"**

Copy the commands GitHub shows and run them:
```bash
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
git branch -M main
git push -u origin main
```

### Option B: Using GitHub Web UI

1. Go to [github.com/new](https://github.com/new)
2. Create a new repository
3. Click **"Upload an existing file"**
4. Upload all files from `D:\Claude\2Watch` (except `node_modules/` and `uploads/`)

## Step 2: Deploy to Railway

### 1. Sign Up / Log In to Railway

Go to [railway.app](https://railway.app) and sign up with GitHub (recommended, easiest).

### 2. Create a New Project

1. Click **"Create New Project"** (top right)
2. Click **"Deploy from GitHub Repo"**
3. Authorize Railway to access GitHub
4. Select your `2watch` repository
5. Click **"Deploy"**

Railway will:
- Detect `package.json`
- Install dependencies automatically
- Start the server

This takes 2-3 minutes. ☕

### 3. Add Environment Variables

Once deployed:

1. In Railway dashboard, click your project
2. Click **"Variables"** tab
3. Add these variables:

```
SUPABASE_URL=https://vpnssvwphcscfjaqgqra.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwbnNzdndwaGNzY2ZqYXFncXJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyOTM1NzQsImV4cCI6MjEwNjg2OTU3NH0.n3VaN4UnClvMeUN5DQ6H5-9hTxXoCRHEm4c76cpyFTg
PORT=3000
NODE_ENV=production
```

4. Click **"Save"**
5. Railway will auto-redeploy with the new variables

### 4. Get Your Live URL

1. In Railway dashboard, click **"Deployments"**
2. Look for **"Domain"** (e.g., `https://2watch-production-12ab.up.railway.app`)
3. That's your live URL! 🎉

## Step 3: Test It

1. Open your Railway URL in a browser
2. You should see the 2Watch home page with "Sign in" button
3. Try creating an account with your Supabase project
4. Create a room and test video playback

## Step 4: Share with Friends

Send them your Railway URL:
```
https://2watch-production-xxxx.up.railway.app
```

They can:
- Sign up with email/password
- Create/join watch parties
- Upload videos (all stored on your Railway instance)
- Chat in real-time

## Costs

- **Railway**: $5/month (includes 100 GB egress, more than enough)
- **Supabase**: Free tier (up to 500k auth users)
- **Total**: $5/month

## Custom Domain (Optional)

If you want a custom domain like `watch.mysite.com`:

1. Buy a domain (Namecheap, GoDaddy, etc.)
2. In Railway dashboard, click **"Settings"**
3. Click **"Domains"**
4. Click **"Add Domain"**
5. Point your domain to Railway's nameservers
6. Takes 24-48 hours to propagate

## Updates & Changes

Every time you push to GitHub:

```bash
git add .
git commit -m "Your changes"
git push
```

Railway automatically redeploys! (takes 1-2 minutes)

## Troubleshooting

### "Deployment failed"
- Check Railway logs: click **"Deployments"** → **"View Logs"**
- Common issues:
  - Missing environment variables
  - Port is hardcoded (use `process.env.PORT`)
  - Old `node_modules` (Railway rebuilds automatically)

### "Can't sign up / auth not working"
- Check environment variables are set correctly
- Verify Supabase credentials in Railway dashboard

### "Uploads not persisting"
- This is expected! Railway's file system is ephemeral
- **Solution:** After videos are played, they're deleted (as designed)
- For permanent storage, add a cloud storage service (S3, etc.)

### "Videos are slow / buffering"
- Railway includes generous bandwidth
- If issues persist, upgrade to Railway Pro ($20/month for 10x more)

## Next Steps

1. ✅ Deploy to Railway
2. 🔗 Share the URL with friends
3. 🎬 Start watching together!
4. (Optional) Add a custom domain
5. (Optional) Set up persistent file storage (S3)

## Questions?

Check the [main README](README.md) or [SETUP.md](SETUP.md) for more details.

---

**Your Railway dashboard:** [railway.app/dashboard](https://railway.app/dashboard)
