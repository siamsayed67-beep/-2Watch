# 🔐 Safe Git Setup - Credentials Hidden

Your Supabase credentials are **protected** and will NOT be pushed to GitHub.

## What Gets Pushed to GitHub ✅

```
├── server.js                  ✅ App code
├── package.json               ✅ Dependencies list
├── package-lock.json          ✅ Dependency lock
├── README.md                  ✅ Documentation
├── DEPLOY.md                  ✅ Deployment guide
├── RAILWAY.md                 ✅ Railway guide
├── .env.example               ✅ Template (no real creds)
├── .gitignore                 ✅ What to ignore
├── public/
│   ├── index.html             ✅ Home page
│   ├── room.html              ✅ Room page
│   ├── js/                    ✅ JavaScript
│   ├── css/                   ✅ Styles
│   └── favicon.svg            ✅ Icon
└── lib/
    └── media.js               ✅ Video link parsing
```

## What Stays Secret (Not Pushed) 🔒

```
├── .env                       🔒 HIDDEN - Your Supabase credentials
├── node_modules/              🔒 HIDDEN - Dependencies (reinstalled by Railway)
└── uploads/                   🔒 HIDDEN - User videos
```

**.env is in .gitignore, so it can't be accidentally pushed.**

## Step-by-Step: Push to GitHub

### 1. Create GitHub Repository

1. Go to https://github.com/new
2. Name: `2watch`
3. Description: `Watch videos together in sync`
4. **Skip adding README** (we already have one)
5. Click **"Create repository"**
6. Copy the HTTPS URL (looks like `https://github.com/YOUR-USERNAME/2watch.git`)

### 2. Push from PowerShell

Open PowerShell in the 2Watch folder:

```powershell
cd D:\Claude\2Watch

# Configure git (first time only)
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"

# Initialize and push
git init
git add .
git commit -m "2Watch: watch videos together in sync with Supabase auth"
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
git branch -M main
git push -u origin main
```

**Replace `YOUR-USERNAME` with your actual GitHub username.**

### 3. Verify on GitHub

Go to your GitHub repo and check:
- ✅ All files are there
- ❌ `.env` is NOT there (only `.env.example`)
- ❌ `node_modules/` is NOT there
- ❌ `uploads/` is NOT there

### 4. Future Updates

Every time you make changes:

```powershell
git add .
git commit -m "Your change description"
git push
```

---

## Security Checklist

- ✅ `.env` in `.gitignore` (won't be pushed)
- ✅ `.env.example` is template-only (no real credentials)
- ✅ `node_modules/` ignored (reinstalled by Railway)
- ✅ `uploads/` ignored (ephemeral storage)
- ✅ No credentials in README or code files
- ✅ `.env` file is **never committed**

**Your Supabase credentials are safe!** 🔐

---

## Deployment

Once pushed to GitHub:

1. Go to https://railway.app
2. Connect your GitHub repo
3. Railway auto-deploys
4. Add `.env` variables in Railway dashboard
5. Your credentials stay on Railway, not in git

**See [DEPLOY.md](DEPLOY.md) for full deployment steps.**
