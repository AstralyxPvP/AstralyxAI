# AstralyxAI 🤖

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![Gemini AI](https://img.shields.io/badge/Google-Gemini_AI-4285F4?style=for-the-badge&logo=google&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?style=for-the-badge&logo=discord&logoColor=white)
![Free Tier](https://img.shields.io/badge/Hosting-100%25_Free-00C853?style=for-the-badge&logo=githubactions&logoColor=white)
![Made in India](https://img.shields.io/badge/Made_in-India_🇮🇳-FF9933?style=for-the-badge)

The official AI companion bot for **AstralyxPvP** — a Minecraft Java 1.9+ FFA PvP server based in India, targeting the ASIA region with ELO rankings and cracked client support.

Built entirely on **Cloudflare Workers** with zero server costs. Powered by Google Gemini AI.

> ⚠️ **License Notice:** This project is source-available for inspiration and learning purposes only. You may **not** copy, redistribute, or deploy this code as-is without permission from the author. All rights reserved © IndianCoder3.

---

## Features

- 🧠 **Gemini AI** — Conversational AI with full AstralyxPvP server context and role-awareness
- 🔍 **Live Web Search** — Powered by Serper.dev, searches Google in real time for current events, news, and scores
- 🌐 **Full Page Reading** — Fetches and reads actual web pages, with Jina.ai as fallback for JS-rendered sites (Twitch, Reddit, etc.)
- 📊 **Live Leaderboard** — Fetches real-time ELO rankings via tool calling
- 🖥️ **Server Status** — Checks if the Minecraft server is online with live player count
- 🧠 **Per-Channel Memory** — Conversation history stored in Cloudflare KV per channel
- 🛡️ **Staff Controls** — AI ban/unban commands restricted to staff roles
- ⚡ **Zero Cold Starts** — Runs on Cloudflare's edge network globally

---

## Slash Commands

| Command | Description | Access |
|---|---|---|
| `/chat` | Chat with the AI | Everyone |
| `/reset` | Clear conversation memory for the channel | Everyone |
| `/lb` | View ELO leaderboard (Sword FFA, Mace FFA, Netherite Pot FFA) | Everyone |
| `/mconline` | Check if the Minecraft server is online | Everyone |
| `/elostats` | Look up a player's ELO across all gamemodes | Everyone |
| `/aiban` | Restrict a user from using the AI | Staff only |
| `/aiunban` | Unrestrict a user from using the AI | Staff only |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (free tier) |
| AI Model | Google Gemini (gemini-3.1-flash-lite-preview) |
| Web Search | Serper.dev Google Search API |
| Page Reading | Direct fetch + Jina.ai reader fallback |
| Memory | Cloudflare KV |
| Commands | Discord Interactions API v10 |

---

## Architecture

```
Discord User
     │
     ▼
Discord Interactions Webhook
     │
     ▼
Cloudflare Worker (index.js)
     │
     ├── Verify Ed25519 signature
     ├── Load KV conversation history
     │
     ▼
Gemini AI (with Tool Calling)
     │
     ├── search_web      → Serper.dev → fetch page → Jina fallback
     ├── get_leaderboard → AstralyxPvP API
     └── get_server_status → AstralyxPvP API
```

---

## Full Setup Guide

### Step 1 — Prerequisites

You'll need accounts on the following platforms (all free):
- [Cloudflare](https://cloudflare.com) — for hosting the Worker
- [Discord Developer Portal](https://discord.com/developers/applications) — for the bot
- [Google AI Studio](https://aistudio.google.com) — for Gemini AI
- [Serper.dev](https://serper.dev) — for web search

Node.js is required if setting up from a PC. If you're on mobile only, all secrets can be set via the Cloudflare dashboard.

---

### Step 2 — Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name (e.g. AstralyxAI)
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token** → click **Reset Token** → copy and save it as `DISCORD_TOKEN`
5. Go to **General Information** tab → copy **Application ID** → save as `DISCORD_APPLICATION_ID`
6. Go to **Bot** tab → scroll down → enable **Server Members Intent** and **Message Content Intent**
7. Go to **OAuth2** → **URL Generator** → select `bot` + `applications.commands` scopes → select permissions → copy the invite link and add the bot to your server
8. Go back to **General Information** → copy **Public Key** → save as `DISCORD_PUBLIC_KEY`

---

### Step 3 — Get your Gemini API Key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API Key** → **Create API Key**
3. Copy it → save as `GOOGLE_API_KEY`

> Free tier gives you generous limits on `gemini-3.1-flash-lite-preview`. No credit card needed.

---

### Step 4 — Get your Serper API Key

1. Go to [serper.dev](https://serper.dev)
2. Sign up with Google or email
3. Go to your **Dashboard** → copy the API key
4. Save it as `SERPER_API_KEY`

> Free tier gives 2,500 searches/month. No credit card needed.

---

### Step 5 — Set up Cloudflare Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
2. Click **Create Worker** → give it a name (e.g. `discord-ai-bot`) → **Deploy**
3. Go to the worker → **Settings** → **Variables and Secrets**
4. Add each secret one by one (click **Add** → type name → paste value → **Deploy**):
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_TOKEN`
   - `GOOGLE_API_KEY`
   - `SERPER_API_KEY`

---

### Step 6 — Create KV Namespace

1. In Cloudflare dashboard → **Workers & Pages** → **KV**
2. Click **Create namespace** → name it `CHAT_HISTORY` → **Add**
3. Copy the **Namespace ID**
4. Open `wrangler.toml` and paste it:

```toml
kv_namespaces = [
  { binding = "CHAT_HISTORY", id = "paste_your_id_here" }
]
```

---

### Step 7 — Configure wrangler.toml

Edit `wrangler.toml` to match your setup:

```toml
name = "discord-ai-bot"
main = "index.js"
compatibility_date = "2026-06-01"

kv_namespaces = [
  { binding = "CHAT_HISTORY", id = "your_kv_namespace_id" }
]

[vars]
GEMINI_MODEL = "gemini-3.1-flash-lite-preview"

[observability.logs]
enabled = true
invocation_logs = true
```

---

### Step 8 — Deploy the Worker

If you have Node.js and Wrangler installed:

```bash
npm install
npx wrangler deploy
```

Or paste the contents of `index.js` directly into the Cloudflare Worker code editor in the dashboard and click **Save and Deploy**.

---

### Step 9 — Register Slash Commands

This is a one-time step. You need Node.js for this.

Create a `.env` file:
```
DISCORD_APPLICATION_ID=your_app_id
DISCORD_TOKEN=your_bot_token
```

Then run:
```bash
node register-commands.js
```

You should see all 7 commands registered successfully.

---

### Step 10 — Set Interactions Endpoint

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → your app
2. Go to **General Information**
3. Under **Interactions Endpoint URL** → paste your Worker URL:
   ```
   https://your-worker-name.your-subdomain.workers.dev/
   ```
4. Click **Save Changes** — Discord will ping your Worker to verify it. If it saves, you're live!

---

## Project Structure

```
├── index.js              # Main Worker — handles all Discord interactions & AI logic
├── register-commands.js  # One-time script to register slash commands
├── wrangler.toml         # Cloudflare Worker config
└── package.json          # Dependencies
```

---

## Troubleshooting

**Bot not responding?**
- Check Cloudflare Worker logs: dash.cloudflare.com → your worker → **Observability** → **Logs**
- Make sure the Interactions Endpoint URL is set correctly in Discord Developer Portal

**429 Rate Limit from Gemini?**
- You hit the per-minute RPM limit. Wait 60 seconds and try again
- Switch to `gemini-2.0-flash-lite` in `wrangler.toml` for higher free limits

**Search not working?**
- Verify `SERPER_API_KEY` is set correctly in Cloudflare secrets
- Check you haven't exceeded 2,500 searches/month on free tier

---

## Credits

Built by **IndianCoder3** ([@IndianCoder3](https://github.com/IndianCoder3)) for **AstralyxPvP**  
Part of the **NebulaGames** dev team alongside DreamLong and Frostrax.

> Coded mostly from a phone. No PC. No excuses. 🫡
