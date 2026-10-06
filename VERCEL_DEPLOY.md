# 🚀 Deploy to Vercel (5 minutes)

Vercel is perfect for 2Watch. It supports Node.js, WebSockets, and real-time sync.

## Step 1: Push to GitHub

First, push your code to GitHub:

```powershell
cd D:\Claude\2Watch

# Configure git (first time only)
git config --global user.name "Your Name"
git config --global user.email "your@email.com"

# Initialize and push
git init
git add .
git commit -m "2Watch: watch videos together in sync with Supabase auth"
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
git branch -M main
git push -u origin main
```

**Replace `YOUR-USERNAME` with your GitHub username.**

## Step 2: Create Vercel Account

1. Go to **https://vercel.com**
2. Click **"Sign Up"**
3. Choose **"Continue with GitHub"**
4. Authorize Vercel to access your GitHub account

## Step 3: Deploy from GitHub

1. After signing in, click **"New Project"** (top right)
2. Search for your `2watch` repository
3. Click **"Import"**
4. Leave settings as default
5. Click **"Deploy"** 

**Wait 2-3 minutes while Vercel builds and deploys.** ⏳

## Step 4: Add Environment Variables

Once deployed:

1. In Vercel dashboard, click your project
2. Go to **"Settings"** tab
3. Click **"Environment Variables"** (left sidebar)
4. Add these variables:

```
SUPABASE_URL = https://vpnssvwphcscfjaqgqra.supabase.co
SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwbnNzdndwaGNzY2ZqYXFncXJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyOTM1NzQsImV4cCI6MjEwNjg2OTU3NH0.n3VaN4UnClvMeUN5DQ6H5-9hTxXoCRHEm4c76cpyFTg
PORT = 3000
NODE_ENV = production
```

5. Click **"Save"**
6. Vercel will auto-redeploy with variables

## Step 5: Get Your Live URL

1. Click the **"Deployments"** tab
2. Look for your domain (e.g., `2watch.vercel.app`)
3. **That's your live website!** 🎉

---

## Test It

1. Open your Vercel URL in a browser
2. You should see the 2Watch home page with "Sign in" button
3. Sign up and create a test room
4. Verify real-time sync works
5. Share the URL with friends!

---

## Make Updates

Every time you push to GitHub, Vercel auto-deploys:

```powershell
# Make changes...
git add .
git commit -m "Your changes"
git push
```

Vercel redeploys automatically (takes 1-2 minutes).

---

## Custom Domain (Optional)

To use your own domain (like `watch.mysite.com`):

1. In Vercel dashboard, go to **"Settings"** → **"Domains"**
2. Add your domain
3. Update your domain's DNS settings (Vercel shows instructions)
4. Takes 24-48 hours to propagate

---

## Costs

- **Vercel**: Free tier (includes $20 monthly credit, more than enough)
- **Supabase**: Free tier
- **Total**: Free for most use cases, $5-20/month if you scale

---

## Troubleshooting

### "Deployment failed"
- Check **Deployments** → **View Logs** for errors
- Usually missing environment variables
- Verify SUPABASE_URL and SUPABASE_ANON_KEY are correct

### "Auth not working"
- Verify environment variables are set in Vercel dashboard
- Refresh the page after adding variables

### "Can't sign up / server error"
- Check Vercel logs: Deployments → View Logs
- Make sure `.env` credentials are in Vercel (not in git)

### "Videos are slow"
- Vercel free tier has generous bandwidth
- Usually just initial load time
- Gets faster after first connection

---

## What's Where

| What | Where |
| --- | --- |
| **Frontend code** | Vercel |
| **Backend code** | Vercel |
| **Video uploads** | Vercel (ephemeral, deleted when room closes) |
| **User accounts** | Supabase |
| **Room data** | Vercel memory |
| **Chat** | Vercel memory |
| **Real-time sync** | Vercel + WebSockets ✅ |

---

## Next Steps

1. ✅ Push to GitHub
2. ✅ Deploy to Vercel
3. ✅ Add environment variables
4. 🔗 Share your URL with friends
5. 🎬 Start watching together!

**Your live site:** `https://YOUR-PROJECT.vercel.app`

---

## Questions?

Check the [main README](README.md) for architecture details or [GIT_SETUP.md](GIT_SETUP.md) for security info.
