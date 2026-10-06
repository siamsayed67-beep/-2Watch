# 🚀 Push to GitHub (Safe - Credentials Hidden)

Your **Supabase credentials in `.env` are protected** and will NOT be pushed to GitHub.

## What's Being Pushed ✅

- ✅ All source code (`server.js`, `public/`, `lib/`)
- ✅ Configuration files (`package.json`, `.gitignore`)
- ✅ Documentation (`README.md`, `DEPLOY.md`, etc.)
- ✅ Template file (`.env.example` with placeholders only)

## What's NOT Being Pushed 🔒

- 🔒 `.env` - Your actual Supabase credentials (in .gitignore)
- 🔒 `node_modules/` - Dependencies (will be reinstalled)
- 🔒 `uploads/` - Video files (ephemeral)

---

## Copy & Paste Commands

Open **PowerShell** in the 2Watch folder and run:

```powershell
# Step 1: Navigate to project (if not already there)
cd D:\Claude\2Watch

# Step 2: Configure git (first time only)
git config --global user.name "Your Name"
git config --global user.email "your@email.com"

# Step 3: Initialize git repo
git init

# Step 4: Add all files
git add .

# Step 5: Create commit
git commit -m "2Watch: watch videos together in sync with Supabase auth"

# Step 6: Add GitHub remote (REPLACE YOUR-USERNAME)
git remote add origin https://github.com/YOUR-USERNAME/2watch.git

# Step 7: Rename branch to main
git branch -M main

# Step 8: Push to GitHub
git push -u origin main
```

---

## Before Running Commands

### 1. Create GitHub Repository

1. Go to **https://github.com/new**
2. Repository name: `2watch`
3. Description: `Watch videos together in sync`
4. Click **"Create repository"** (skip adding README)
5. Copy the HTTPS URL it shows

### 2. Replace in Commands

Find this line in the commands above:
```
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
```

Replace `YOUR-USERNAME` with your actual GitHub username.

---

## Step-by-Step Example

```powershell
# Your info
git config --global user.name "John Doe"
git config --global user.email "john@example.com"

cd D:\Claude\2Watch

git init
git add .
git commit -m "2Watch: watch videos together in sync with Supabase auth"

# If your GitHub username is "johndoe"
git remote add origin https://github.com/johndoe/2watch.git

git branch -M main
git push -u origin main
```

---

## Verify It Worked ✅

1. Go to your GitHub repo: `https://github.com/YOUR-USERNAME/2watch`
2. Check:
   - ✅ `server.js`, `package.json`, `public/` folder are there
   - ✅ `README.md` is displayed
   - ✅ `.env.example` (template) is there
   - ❌ `.env` file is NOT there
   - ❌ `node_modules/` folder is NOT there

---

## Troubleshooting

### "fatal: not a git repository"
- Make sure you're in the `D:\Claude\2Watch` folder
- Run `git init` first

### "fatal: remote already exists"
- You already added the remote
- Run `git remote -v` to see existing remotes
- If wrong, run `git remote remove origin` and try again

### "Branch 'main' set up to track remote 'origin/main'"
- This is normal! It means it worked

### ".env file appeared in git"
- Don't worry, it didn't push because it's in .gitignore
- But don't ever commit `.env` manually

---

## Next: Deploy to Railway

Once pushed to GitHub:

1. Go to **https://railway.app**
2. Sign up with GitHub
3. Click **"New Project"** → **"Deploy from GitHub Repo"**
4. Select `2watch` and click **"Deploy"**
5. Add environment variables (SUPABASE_URL, SUPABASE_ANON_KEY)
6. Done! 🎉

**See [DEPLOY.md](DEPLOY.md) for detailed Railway instructions.**

---

## Summary

| Step | What It Does |
| --- | --- |
| `git init` | Creates a local git repository |
| `git add .` | Stages all files (except .gitignore'd ones) |
| `git commit` | Creates a snapshot with a message |
| `git remote add` | Connects to your GitHub repo |
| `git push` | Uploads everything to GitHub |

**Your `.env` file is safe!** It's in `.gitignore` and will never be pushed. 🔒
