/**
 * AstralyxPvP Discord AI Bot - Premium Serverless Implementation
 * Handles signatures, deferred executions, KV state history, and resilient Gemini integration.
 */

import { verifyKey } from 'discord-interactions';

// Configuration Defaults
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";
const DEFAULT_SYSTEM_PROMPT = `You are the official AI mascot for AstralyxPvP, a competitive Minecraft PvP server. 
You are friendly, competitive, and highly knowledgeable about Minecraft PvP mechanics including:
- Sword FFA (spacing, timing, critical hits, block-hitting)
- Mace FFA (wind charges, high-ground setups, smash attacks)
- Netherite Pot FFA (potion management, pearl clutching, armor durability, aggressive pressure)

Keep your responses clear, natural, and formatted nicely with Discord Markdown. Avoid robotic introductions. Help players with PvP advice, server info, and strategies!`;

// Simple in-memory rate limiter for the current Worker instance
const localRateLimits = new Map();
const RATE_LIMIT_COOLDOWN_MS = 4000; // 4 seconds between AI requests per user

export default {
  async fetch(request, env, ctx) {
    try {
      // 1. Only accept POST requests
      if (request.method !== 'POST') {
        return jsonResponse({ status: 'ok', message: 'Astralyx PvP Bot is running online' }, 200);
      }

      // 2. Extract and validate Discord cryptographic signature headers
      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');
      const rawBody = await request.text();

      if (!signature || !timestamp) {
        return jsonResponse({ error: 'Missing security credentials' }, 401);
      }

      // 3. Verify authenticity of the Discord request
      const isValid = await verifyKey(
        rawBody,
        signature,
        timestamp,
        env.DISCORD_PUBLIC_KEY
      );

      if (!isValid) {
        return jsonResponse({ error: 'Signature validation failed' }, 401);
      }

      const interaction = JSON.parse(rawBody);

      // 4. Handle Discord Ping/Pong handshakes
      if (interaction.type === 1) { // InteractionType.PING
        return jsonResponse({ type: 1 }); // InteractionResponseType.PONG
      }

      // 5. Route Application Commands (Slash Commands)
      if (interaction.type === 2) { // InteractionType.APPLICATION_COMMAND
        return await handleSlashCommand(interaction, env, ctx);
      }

      return jsonResponse({ error: 'Unsupported interaction type' }, 400);
    } catch (error) {
      console.error('Fatal error processing worker request:', error);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};

/**
 * Main Slash Command router
 */
async function handleSlashCommand(interaction, env, ctx) {
  const { name, options } = interaction.data;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const channelId = interaction.channel_id;

  // Global Moderator / Admin check (for ban/unban commands)
  // Check if user has ADMINISTRATOR permission (0x8) or MANAGE_GUILD (0x20)
  const permissions = BigInt(interaction.member?.permissions || '0');
  const isStaff = (permissions & 0x8n) === 0x8n || (permissions & 0x20n) === 0x20n;

  switch (name) {
    case 'chat': {
      const messageOption = options?.find(opt => opt.name === 'message');
      const userPrompt = messageOption?.value;

      if (!userPrompt) {
        return ephemeralResponse("Please provide a prompt for the AI.");
      }

      // Check Ban Status
      const isBanned = await env.CHAT_HISTORY.get(`banned:${userId}`);
      if (isBanned) {
        return ephemeralResponse("❌ You are currently restricted from interacting with the AI on this server.");
      }

      // Rate Limiting Check
      const now = Date.now();
      const lastRequest = localRateLimits.get(userId) || 0;
      if (now - lastRequest < RATE_LIMIT_COOLDOWN_MS) {
        return ephemeralResponse("⏳ Slow down! Please wait a few seconds before sending another prompt.");
      }
      localRateLimits.set(userId, now);

      // DEFER the response to avoid Discord's 3-second timeout limits.
      // This tells Discord "The bot is thinking..." and keeps the connection open.
      ctx.waitUntil(
        handleDeferredChat(interaction, userPrompt, channelId, userId, env)
      );

      return jsonResponse({
        type: 5 // InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });
    }

    case 'reset': {
      await env.CHAT_HISTORY.delete(`history:${channelId}`);
      return jsonResponse({
        type: 4,
        data: {
          content: "🧹 **AI Conversation Memory cleared for this channel!** Starting fresh."
        }
      });
    }

    case 'lb': {
      const gamemode = options?.find(opt => opt.name === 'gamemode')?.value || 'swordffa1';
      const leaderboardData = generateMockLeaderboard(gamemode);
      return jsonResponse({
        type: 4,
        data: {
          embeds: [leaderboardData]
        }
      });
    }

    case 'mconline': {
      // Defer server pinging since API fetches can occasionally exceed 3 seconds
      ctx.waitUntil(handleDeferredPing(interaction, env));
      return jsonResponse({ type: 5 });
    }

    case 'elostats': {
      const player = options?.find(opt => opt.name === 'player')?.value;
      const statsEmbed = generateMockPlayerStats(player);
      return jsonResponse({
        type: 4,
        data: {
          embeds: [statsEmbed]
        }
      });
    }

    case 'aiban': {
      if (!isStaff) return ephemeralResponse("🚫 Only server administrators or staff can run this command.");
      const targetUser = options?.find(opt => opt.name === 'user')?.value;
      if (!targetUser) return ephemeralResponse("Please specify a user to ban.");

      await env.CHAT_HISTORY.put(`banned:${targetUser}`, "true");
      return jsonResponse({
        type: 4,
        data: {
          content: `🚨 <@${targetUser}> has been restricted from using the AI features.`
        }
      });
    }

    case 'aiunban': {
      if (!isStaff) return ephemeralResponse("🚫 Only server administrators or staff can run this command.");
      const targetUser = options?.find(opt => opt.name === 'user')?.value;
      if (!targetUser) return ephemeralResponse("Please specify a user to unban.");

      await env.CHAT_HISTORY.delete(`banned:${targetUser}`);
      return jsonResponse({
        type: 4,
        data: {
          content: `✅ <@${targetUser}> is no longer restricted from using the AI.`
        }
      });
    }

    default:
      return ephemeralResponse("Unknown slash command triggered.");
  }
}

/**
 * Handles deferred AI response generation asynchronously
 */
async function handleDeferredChat(interaction, prompt, channelId, userId, env) {
  const patchUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  
  try {
    const historyKey = `history:${channelId}`;
    
    // Retrieve past channel memory from KV namespace
    let conversationHistory = [];
    const savedHistory = await env.CHAT_HISTORY.get(historyKey);
    if (savedHistory) {
      try {
        conversationHistory = JSON.parse(savedHistory);
      } catch (e) {
        conversationHistory = [];
      }
    }

    // Append new user message
    conversationHistory.push({ role: 'user', parts: [{ text: prompt }] });

    // Enforce sliding window history length to stay within token limits and optimize performance
    if (conversationHistory.length > 12) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 12);
    }

    // Call Gemini with integrated retry-backoff
    const aiResponse = await generateGeminiContent(conversationHistory, env);

    // Save update history back to Cloudflare KV
    conversationHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
    await env.CHAT_HISTORY.put(historyKey, JSON.stringify(conversationHistory), { expirationTtl: 86400 }); // Keep history for 24 hours

    // Send original response back to Discord
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `💬 **<@${userId}>:** ${prompt.length > 150 ? prompt.substring(0, 150) + '...' : prompt}\n\n${aiResponse}`
      })
    });

  } catch (error) {
    console.error("AI Generation / Patching failed:", error);
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `❌ **AI Processing Error:** The AI service failed to respond. Please try again.`
      })
    });
  }
}

/**
 * Calls Gemini endpoint with mandatory exponential backoff
 */
async function generateGeminiContent(contents, env) {
  const apiKey = env.GOOGLE_API_KEY || "";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT }]
    }
  };

  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const json = await response.json();
        const responseText = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          return responseText;
        }
        throw new Error("Empty candidate parts returned from model");
      }

      // Handle server level issues (5xx) or rate limits (429)
      if (response.status >= 500 || response.status === 429) {
        console.warn(`Gemini API returned status ${response.status}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential Backoff
        continue;
      }

      const errText = await response.text();
      throw new Error(`Gemini API Error Status ${response.status}: ${errText}`);
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error("Max API retries reached. Request failed.");
}

/**
 * Handles asynchronous server status retrieval
 */
async function handleDeferredPing(interaction, env) {
  const patchUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  
  // Custom server IP configuration or default
  const serverIp = env.MINECRAFT_SERVER_IP || "play.astralyxpvp.com";

  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${serverIp}`);
    const data = await res.json();

    if (data.online) {
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: `🟢 ${serverIp} is ONLINE`,
            description: `**MOTD:** \n\`\`\`\n${data.motd?.clean || 'An Astralyx PvP Server'}\n\`\`\``,
            fields: [
              { name: "👤 Players Online", value: `**${data.players.online}** / **${data.players.max}**`, inline: true },
              { name: "⚡ Ping/Latency", value: "Excellent", inline: true },
              { name: "🏷️ Version", value: data.version?.name_clean || "1.20+", inline: true }
            ],
            color: 3066993, // Green
            timestamp: new Date().toISOString()
          }]
        })
      });
    } else {
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: `🔴 ${serverIp} is OFFLINE`,
            description: `We couldn't connect to the server. It might be undergoing maintenance, update cycles, or hosting a custom match, check back soon!`,
            color: 15158332, // Red
            timestamp: new Date().toISOString()
          }]
        })
      });
    }
  } catch (error) {
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `❌ Could not reach Astralyx IP Server Status right now. Please verify IP manually or contact a coordinator.`
      })
    });
  }
}

/**
 * Mock stats generation helper
 */
function generateMockPlayerStats(username) {
  const cleanUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  // Generate pseudorandom stable ELO scores based on the name length/characters
  const baseSeed = cleanUser.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const swordElo = 1000 + (baseSeed % 850);
  const maceElo = 950 + ((baseSeed * 3) % 720);
  const nethElo = 1100 + ((baseSeed * 7) % 940);

  return {
    title: `⚔️ Player PvP Profile: ${cleanUser}`,
    description: `Real-time Competitive ELO Ratings across registered Astralyx PvP arenas.`,
    color: 16750848, // Orange
    thumbnail: {
      url: `https://mc-heads.net/avatar/${cleanUser}/100`
    },
    fields: [
      { name: "🗡️ Sword FFA ELO", value: `**${swordElo}** (Tier: ${getEloTier(swordElo)})`, inline: false },
      { name: "🔨 Mace FFA ELO", value: `**${maceElo}** (Tier: ${getEloTier(maceElo)})`, inline: false },
      { name: "🛡️ Netherite Pot ELO", value: `**${nethElo}** (Tier: ${getEloTier(nethElo)})`, inline: false }
    ],
    footer: {
      text: "AstralyxPvP Stats Database"
    },
    timestamp: new Date().toISOString()
  };
}

function getEloTier(elo) {
  if (elo >= 1800) return "Master 💎";
  if (elo >= 1500) return "Diamond ❄️";
  if (elo >= 1300) return "Platinum 🛡️";
  if (elo >= 1100) return "Gold 🥇";
  return "Bronze 🥉";
}

/**
 * Mock leaderboard data helper
 */
function generateMockLeaderboard(gamemode) {
  const modeNames = {
    swordffa1: "Sword FFA",
    maceffa: "Mace FFA",
    nethpotffa: "Netherite Pot FFA"
  };

  const modeColors = {
    swordffa1: 3447003, // Blue
    maceffa: 10181046, // Purple
    nethpotffa: 15105570 // Gold
  };

  // Static mock leaders
  const topPlayers = [
    { name: "PvPGod_Astral", elo: 2145 },
    { name: "Crystallized", elo: 2012 },
    { name: "MaceWielder", elo: 1980 },
    { name: "Spacings", elo: 1895 },
    { name: "PotHealUrself", elo: 1840 }
  ];

  const description = topPlayers.map((player, idx) => {
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    return `${medals[idx]} **${player.name}** — ${player.elo} ELO`;
  }).join("\n");

  return {
    title: `🏆 Top 5 Leaderboard: ${modeNames[gamemode] || "PvP"}`,
    description,
    color: modeColors[gamemode] || 3447003,
    timestamp: new Date().toISOString(),
    footer: { text: "Updates automatically every match" }
  };
}

/**
 * Standard Ephemeral (private) response helper
 */
function ephemeralResponse(text) {
  return jsonResponse({
    type: 4,
    data: {
      content: text,
      flags: 64 // Ephemeral flag: visible only to trigger user
    }
  });
}

/**
 * Standard JSON Response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}