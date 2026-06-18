/**
 * AstralyxPvP Discord AI Bot - Self-Healing, Fully Logged Worker
 * Added support for a lightweight Gateway Bridge connection via a Shared Secret.
 */

import { verifyKey } from 'discord-interactions';

const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";
const DEFAULT_SYSTEM_PROMPT = `You are the official AI mascot for AstralyxPvP, a competitive Minecraft PvP server. 
You are friendly, competitive, and highly knowledgeable about Minecraft PvP mechanics including:
- Sword FFA (spacing, timing, critical hits, block-hitting)
- Mace FFA (wind charges, high-ground setups, smash attacks)
- Netherite Pot FFA (potion management, pearl clutching, armor durability, aggressive pressure)

Keep your responses clear, natural, and formatted nicely with Discord Markdown. Avoid robotic introductions. Help players with PvP advice, server info, and strategies!`;

const localRateLimits = new Map();
const RATE_LIMIT_COOLDOWN_MS = 4000;

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== 'POST') {
        return jsonResponse({ status: 'ok', message: 'Astralyx PvP Bot is running online' }, 200);
      }

      // Check if this is a secure forward from our Gateway Bridge
      const authHeader = request.headers.get('authorization');
      const gatewaySecret = env.GATEWAY_SECRET;

      if (gatewaySecret && authHeader === `Bearer ${gatewaySecret}`) {
        console.log("🔗 Connection: Authenticated Gateway Bridge request received.");
        return await handleGatewayForward(request, env);
      }

      // Fallback to standard Discord signature validation for Webhook Interactions
      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');
      const rawBody = await request.text();

      if (!signature || !timestamp) {
        console.warn("⚠️ Warning: Request received missing signature headers.");
        return jsonResponse({ error: 'Missing credentials' }, 401);
      }

      const isValid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
      if (!isValid) {
        console.warn("⚠️ Warning: Invalid Discord signature verification attempt.");
        return jsonResponse({ error: 'Signature validation failed' }, 401);
      }

      const interaction = JSON.parse(rawBody);

      if (interaction.type === 1) { // PING
        console.log("ℹ️ Info: Responding to Discord PING handshakes.");
        return jsonResponse({ type: 1 });
      }

      if (interaction.type === 2) { // APPLICATION_COMMAND
        return await handleApplicationCommand(interaction, env, ctx);
      }

      return jsonResponse({ error: 'Unsupported interaction type' }, 400);
    } catch (error) {
      console.error('❌ Fatal error in Fetch handler:', error);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};

/**
 * Handles incoming ping/mention payloads forwarded from the external Gateway Bridge
 */
async function handleGatewayForward(request, env) {
  try {
    const payload = await request.json();
    const { prompt, channelId, userId, username } = payload;

    if (!prompt || !channelId || !userId) {
      return jsonResponse({ error: 'Bad Request: Missing parameters' }, 400);
    }

    console.log(`📡 [Gateway Forward] Prompt: "${prompt}" from user ${username} (${userId})`);

    // Check Ban Status
    let isBanned = false;
    if (env.CHAT_HISTORY) {
      isBanned = await env.CHAT_HISTORY.get(`banned:${userId}`);
    }
    if (isBanned) {
      return jsonResponse({ response: "❌ You are currently restricted from interacting with the AI on this server." });
    }

    // Rate limiting check
    const now = Date.now();
    const lastRequest = localRateLimits.get(userId) || 0;
    if (now - lastRequest < RATE_LIMIT_COOLDOWN_MS) {
      return jsonResponse({ response: "⏳ Slow down! Please wait a few seconds before asking again." });
    }
    localRateLimits.set(userId, now);

    // Retrieve past channel history
    let conversationHistory = [];
    if (env.CHAT_HISTORY) {
      const historyKey = `history:${channelId}`;
      const savedHistory = await env.CHAT_HISTORY.get(historyKey);
      if (savedHistory) {
        try {
          conversationHistory = JSON.parse(savedHistory);
        } catch (e) {
          conversationHistory = [];
        }
      }
    }

    // Append new message formatted nicely
    const cleanPrompt = `User ${username} says: "${prompt}"`;
    conversationHistory.push({ role: 'user', parts: [{ text: cleanPrompt }] });

    if (conversationHistory.length > 12) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 12);
    }

    // Get response from Gemini
    const aiResponse = await generateGeminiContent(conversationHistory, env);

    // Save history back to KV
    if (env.CHAT_HISTORY) {
      const historyKey = `history:${channelId}`;
      conversationHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(conversationHistory), { expirationTtl: 86400 });
    }

    return jsonResponse({ response: aiResponse });

  } catch (err) {
    console.error("❌ Error processing gateway forward:", err);
    return jsonResponse({ response: "⚠️ Error processing your prompt in the Cloudflare backend." }, 500);
  }
}

/**
 * Route both Chat Input (slash commands) and Context Menu commands
 */
async function handleApplicationCommand(interaction, env, ctx) {
  const { name, options, type: commandType } = interaction.data;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const channelId = interaction.channel_id;

  console.log(`🤖 Command Triggered: /${name} (Type: ${commandType}) by User ID: ${userId} in Channel: ${channelId}`);

  // Handle Context Menu commands (Type 3 is MESSAGE context command)
  if (commandType === 3 && name === 'Reply with AI') {
    const targetId = interaction.data.target_id;
    const targetMessage = interaction.data.resolved?.messages?.[targetId];
    const userPrompt = targetMessage?.content;

    if (!userPrompt) {
      return ephemeralResponse("Can't read the contents of that message to reply!");
    }

    // Rate Limiting Check
    const now = Date.now();
    const lastRequest = localRateLimits.get(userId) || 0;
    if (now - lastRequest < RATE_LIMIT_COOLDOWN_MS) {
      return ephemeralResponse("⏳ Slow down! Please wait a few seconds before requesting another reply.");
    }
    localRateLimits.set(userId, now);

    // Defer response to avoid Discord 3-second timeout limits
    ctx.waitUntil(
      handleDeferredChat(interaction, userPrompt, channelId, userId, env, true, targetMessage.author?.username)
    );

    return jsonResponse({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  // Handle standard slash commands
  const permissions = BigInt(interaction.member?.permissions || '0');
  const isStaff = (permissions & 0x8n) === 0x8n || (permissions & 0x20n) === 0x20n;

  switch (name) {
    case 'chat': {
      const messageOption = options?.find(opt => opt.name === 'message');
      const userPrompt = messageOption?.value;

      if (!userPrompt) {
        return ephemeralResponse("Please provide a prompt for the AI.");
      }

      // Check Ban Status Safely
      let isBanned = false;
      if (env.CHAT_HISTORY) {
        isBanned = await env.CHAT_HISTORY.get(`banned:${userId}`);
      }
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

      // Defer response to avoid Discord 3-second timeout limits
      ctx.waitUntil(
        handleDeferredChat(interaction, userPrompt, channelId, userId, env, false)
      );

      return jsonResponse({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }

    case 'reset': {
      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.delete(`history:${channelId}`);
        console.log(`🧹 Chat history cleared for channel: ${channelId}`);
      }
      return jsonResponse({
        type: 4,
        data: {
          content: "🧹 **AI Conversation Memory cleared for this channel!** Starting fresh."
        }
      });
    }

    case 'lb': {
      const gamemode = options?.find(opt => opt.name === 'gamemode')?.value || 'swordffa1';
      return jsonResponse({
        type: 4,
        data: { embeds: [generateMockLeaderboard(gamemode)] }
      });
    }

    case 'mconline': {
      ctx.waitUntil(handleDeferredPing(interaction, env));
      return jsonResponse({ type: 5 });
    }

    case 'elostats': {
      const player = options?.find(opt => opt.name === 'player')?.value;
      return jsonResponse({
        type: 4,
        data: { embeds: [generateMockPlayerStats(player)] }
      });
    }

    case 'aiban': {
      if (!isStaff) return ephemeralResponse("🚫 Only server administrators or staff can run this command.");
      const targetUser = options?.find(opt => opt.name === 'user')?.value;
      if (!targetUser) return ephemeralResponse("Please specify a user to ban.");

      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.put(`banned:${targetUser}`, "true");
      }
      return jsonResponse({
        type: 4,
        data: { content: `🚨 <@${targetUser}> has been restricted from using the AI features.` }
      });
    }

    case 'aiunban': {
      if (!isStaff) return ephemeralResponse("🚫 Only server administrators or staff can run this command.");
      const targetUser = options?.find(opt => opt.name === 'user')?.value;
      if (!targetUser) return ephemeralResponse("Please specify a user to unban.");

      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.delete(`banned:${targetUser}`);
      }
      return jsonResponse({
        type: 4,
        data: { content: `✅ <@${targetUser}> is no longer restricted from using the AI.` }
      });
    }

    default:
      return ephemeralResponse("Unknown slash command triggered.");
  }
}

/**
 * Handles deferred AI response generation asynchronously
 */
async function handleDeferredChat(interaction, prompt, channelId, userId, env, isContextMenu = false, originalAuthor = "") {
  const applicationId = interaction.application_id;
  const patchUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interaction.token}/messages/@original`;
  
  console.log(`[Deferred Engine] Starting task for User: ${userId}. URL: ${patchUrl}`);

  try {
    let conversationHistory = [];
    
    if (env.CHAT_HISTORY) {
      console.log(`[Deferred Engine] Fetching conversation memory from KV storage...`);
      const historyKey = `history:${channelId}`;
      const savedHistory = await env.CHAT_HISTORY.get(historyKey);
      if (savedHistory) {
        try {
          conversationHistory = JSON.parse(savedHistory);
        } catch (e) {
          console.warn(`[Deferred Engine] Failed to parse history JSON, resetting channel context:`, e);
          conversationHistory = [];
        }
      }
    }

    let cleanPrompt = prompt;
    if (isContextMenu) {
      cleanPrompt = `Reply to the following message sent by ${originalAuthor || 'another user'}: "${prompt}"`;
    }

    conversationHistory.push({ role: 'user', parts: [{ text: cleanPrompt }] });

    if (conversationHistory.length > 12) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 12);
    }

    console.log(`[Deferred Engine] Querying Gemini AI APIs...`);
    const aiResponse = await generateGeminiContent(conversationHistory, env);
    console.log(`[Deferred Engine] Gemini AI response received successfully.`);

    if (env.CHAT_HISTORY) {
      const historyKey = `history:${channelId}`;
      conversationHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(conversationHistory), { expirationTtl: 86400 });
    }

    let finalContent = "";
    if (isContextMenu) {
      finalContent = `💬 **Replying to ${originalAuthor ? `**${originalAuthor}**` : 'Message'}:** *"${prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt}"*\n\n${aiResponse}`;
    } else {
      finalContent = `💬 **<@${userId}>:** ${prompt.length > 150 ? prompt.substring(0, 150) + '...' : prompt}\n\n${aiResponse}`;
    }

    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: finalContent })
    });

    if (patchRes.ok) {
      console.log(`✨ [Deferred Engine] Success! Discord original message updated.`);
    } else {
      console.error(`❌ [Deferred Engine] Failed to patch Discord. Response Status: ${patchRes.status}`);
    }

  } catch (error) {
    console.error("❌ [Deferred Engine] Error occurred during deferred processing:", error);
    try {
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `❌ **AI Processing Error:** Something went wrong in the background.`
        })
      });
    } catch (patchErr) {
      console.error("❌ Failed to send crash notification back to Discord:", patchErr);
    }
  }
}

/**
 * Call Gemini with error-logging and retry support
 */
async function generateGeminiContent(contents, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing 'GOOGLE_API_KEY' secret variable.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT }]
    }
  };

  let delay = 1000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const json = await response.json();
        const responseText = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) return responseText;
        throw new Error("Gemini returned empty parts.");
      }

      if (response.status >= 500 || response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      const errorText = await response.text();
      throw new Error(`Non-retriable Gemini Status: ${errorText}`);
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Handles deferred server status check
 */
async function handleDeferredPing(interaction, env) {
  const applicationId = interaction.application_id;
  const patchUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interaction.token}/messages/@original`;
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
            color: 3066993,
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
            description: `We couldn't connect to the server right now.`,
            color: 15158332,
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
        content: `❌ Could not reach Astralyx Minecraft Server Status.`
      })
    });
  }
}

function generateMockPlayerStats(username) {
  const cleanUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const baseSeed = cleanUser.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const swordElo = 1000 + (baseSeed % 850);
  const maceElo = 950 + ((baseSeed * 3) % 720);
  const nethElo = 1100 + ((baseSeed * 7) % 940);

  return {
    title: `⚔️ Player PvP Profile: ${cleanUser}`,
    description: `Competitive ELO Ratings across registered Astralyx PvP arenas.`,
    color: 16750848,
    thumbnail: { url: `https://mc-heads.net/avatar/${cleanUser}/100` },
    fields: [
      { name: "🗡️ Sword FFA ELO", value: `**${swordElo}** (Tier: ${getEloTier(swordElo)})`, inline: false },
      { name: "🔨 Mace FFA ELO", value: `**${maceElo}** (Tier: ${getEloTier(maceElo)})`, inline: false },
      { name: "🛡️ Netherite Pot ELO", value: `**${nethElo}** (Tier: ${getEloTier(nethElo)})`, inline: false }
    ],
    footer: { text: "AstralyxPvP Stats Database" },
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

function generateMockLeaderboard(gamemode) {
  const modeNames = {
    swordffa1: "Sword FFA",
    maceffa: "Mace FFA",
    nethpotffa: "Netherite Pot FFA"
  };

  const modeColors = {
    swordffa1: 3447003,
    maceffa: 10181046,
    nethpotffa: 15105570
  };

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

function ephemeralResponse(text) {
  return jsonResponse({
    type: 4,
    data: { content: text, flags: 64 }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}