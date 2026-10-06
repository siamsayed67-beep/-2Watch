# 🚀 Quick Deploy to Railway (5 minutes)

## Step 1: Push to GitHub

Run these commands in PowerShell (in the 2Watch folder):

```powershell
cd D:\Claude\2Watch

# Initialize git
git init
git add .
git commit -m "2Watch: video sync app with Supabase auth"

# Create a new repo on GitHub first, then run:
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
git branch -M main
git push -u origin main
```

**Replace `YOUR-USERNAME` with your actual GitHub username.**

## Step 2: Create GitHub Repo

1. Go to https://github.com/new
2. Name it: `2watch`
3. Description: "Watch videos together in sync"
4. Click **"Create repository"** (no need to add README, we have one)

## Step 3: Get Push URL

GitHub will show you a URL like:
```
https://github.com/YOUR-USERNAME/2watch.git
```

Use that in Step 1 above.

## Step 4: Deploy to Railway

1. Go to https://railway.app
2. Sign up with GitHub (click the GitHub button)
3. Authorize Railway to access your GitHub account
4. Click **"New Project"**
5. Click **"Deploy from GitHub Repo"**
6. Select `2watch` repository
7. Wait 2-3 minutes for deployment ⏳

## Step 5: Add Environment Variables

Once deployed:

1. In Railway dashboard, click **"Variables"**
2. Click **"Raw Editor"**
3. Paste this (all one line or separate):

```
SUPABASE_URL=https://vpnssvwphcscfjaqgqra.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwbnNzdndwaGNzY2ZqYXFncXJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyOTM1NzQsImV4cCI6MjEwNjg2OTU3NH0.n3VaN4UnClvMeUN5DQ6H5-9hTxXoCRHEm4c76cpyFTg
PORT=3000
NODE_ENV=production
```

4. Click **"Save"**
5. Wait 1 minute for redeploy

## Step 6: Get Your Live URL

1. Click **"Deployments"**
2. Look for the domain (e.g., `https://2watch-production-abc.up.railway.app`)
3. **That's your live website!** 🎉

## Test It

1. Open your Railway URL
2. Sign up or log in
3. Create a room
4. Share the URL with friends!

## Make Changes

Every time you push to GitHub, Railway auto-redeploys:

```powershell
# Make changes...
git add .
git commit -m "Your changes"
git push
```

---

**Need help?** See [RAILWAY.md](RAILWAY.md) for detailed troubleshooting.
