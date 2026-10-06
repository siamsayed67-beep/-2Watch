# 🚀 Push to GitHub (Safe - Credentials Protected)

Your **Supabase credentials in `.env` are protected** and will NOT be pushed to GitHub.

## 🔐 What's Protected

| Component | Status | Details |
| --- | --- | --- |
| **Supabase credentials** | 🔒 Protected | `.env` is in `.gitignore` - won't be pushed |
| **Source code** | ✅ Pushed | All app files go to GitHub |
| **node_modules** | 🔒 Ignored | Won't push (Vercel rebuilds it) |
| **uploads** | 🔒 Ignored | Won't push (ephemeral) |

---

## Copy & Paste Commands

Open **PowerShell** in the 2Watch folder and run:

```powershell
# First time git setup
git config --global user.name "Your Name"
git config --global user.email "your@email.com"

cd D:\Claude\2Watch

# Initialize and push
git init
git add .
git commit -m "2Watch: watch videos together in sync with Supabase auth"
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
git branch -M main
git push -u origin main
```

**Replace `YOUR-USERNAME` with your GitHub username.**

---

## Before Running Commands

### 1. Create GitHub Repository

1. Go to **https://github.com/new**
2. Repository name: `2watch`
3. Description: `Watch videos together in sync`
4. Click **"Create repository"** (skip README)
5. Copy the HTTPS URL it shows

### 2. Update the Commands

Replace this line:
```
git remote add origin https://github.com/YOUR-USERNAME/2watch.git
```

With your actual GitHub username.

---

## Verify It Worked ✅

1. Go to your GitHub repo: `https://github.com/YOUR-USERNAME/2watch`
2. Check:
   - ✅ `server.js`, `package.json`, `public/` are there
   - ✅ `README.md` is displayed
   - ✅ `VERCEL_DEPLOY.md` is there
   - ✅ `.env.example` (template) is there
   - ❌ `.env` file is NOT there (safe! 🔒)
   - ❌ `node_modules/` is NOT there

---

## Next: Deploy to Vercel

Once pushed to GitHub:

1. Go to **https://vercel.com**
2. Sign up with GitHub
3. Click **"New Project"** → **"Import Project"**
4. Select your `2watch` repository
5. Click **"Deploy"**
6. Add environment variables (SUPABASE_URL, SUPABASE_ANON_KEY)
7. Done! 🎉

**See [VERCEL_DEPLOY.md](VERCEL_DEPLOY.md) for detailed Vercel instructions.**

---

## Troubleshooting

### "fatal: not a git repository"
- Make sure you're in `D:\Claude\2Watch` folder
- Run `git init` first

### "fatal: remote already exists"
- Run `git remote -v` to see existing remotes
- If wrong, run `git remote remove origin` and try again

### ".env file appeared in git"
- Don't worry, it won't push (it's in .gitignore)
- Never manually commit `.env`

---

## Summary

| Step | What It Does |
| --- | --- |
| `git init` | Create local git repository |
| `git add .` | Stage all files (except .gitignore'd ones) |
| `git commit` | Create a snapshot with message |
| `git remote add` | Connect to your GitHub repo |
| `git push` | Upload to GitHub |

**Your `.env` is safe!** 🔒 It's in `.gitignore` and will never be pushed.

---

**Next:** [VERCEL_DEPLOY.md](VERCEL_DEPLOY.md)
