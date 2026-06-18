/**
 * AstralyxPvP Discord AI Bot - Cloudflare Worker
 * Fully integrated with strict Role ID hierarchy and staff-command permission guards.
 */

import { verifyKey } from 'discord-interactions';

const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

// Precise Role ID Hierarchy List (Highest to Lowest)
const ROLE_HIERARCHY = [
  { id: '1477025238784151554', tag: 'Owner' },
  { id: '1477291491003994214', tag: 'Co-Owner' },
  { id: '1502815102716608552', tag: 'Chief Manager' },
  { id: '1497335106074050620', tag: 'Sr. Manager' },
  { id: '1483209618485284964', tag: 'Manager' },
  { id: '1498734182615089314', tag: 'Head of General Affairs' },
  { id: '1498734243352678630', tag: 'Head of Internal Affairs' },
  { id: '1497316294632931358', tag: 'Developer' },
  { id: '1497316250945323070', tag: 'Admin' },
  { id: '1497316120452136960', tag: 'Sr. Mod' },
  { id: '1477025502119334109', tag: 'Mod' },
  { id: '1497316057214484735', tag: 'Jr. Mod' },
  { id: '1477025528174219476', tag: 'Helper' },
  { id: '1501217374102229185', tag: 'Trial Staff' },
  { id: '1511596382706991144', tag: 'Veteran (Ex-Staff)' },
  { id: '1477025683061604432', tag: 'YouTube Rank' },
  { id: '1497315976017084457', tag: 'Astralyx+' },
  { id: '1477031144426836183', tag: 'AstralyxBot' },
  { id: '1484285067218911493', tag: 'Chat Assistant' },
  { id: '1484284923794685992', tag: 'Meme Lord' },
  { id: '1477025773033623673', tag: 'Member' }
];

// Admin and above role IDs allowed to run administrative AI commands (/aiban, /aiunban)
const ADMIN_AND_ABOVE_ROLE_IDS = [
  '1477025238784151554', // Owner
  '1477291491003994214', // Co-Owner
  '1502815102716608552', // Chief Manager
  '1497335106074050620', // Sr. Manager
  '1483209618485284964', // Manager
  '1498734182615089314', // Head of General Affairs
  '1498734243352678630', // Head of Internal Affairs
  '1497316294632931358', // Developer
  '1497316250945323070'  // Admin
];

const DEVELOPER_USER_ID = "1513925512118931551";

const DEFAULT_SYSTEM_PROMPT = `You are the official AI mascot for AstralyxPvP, a competitive Minecraft PvP server. 

⚠️ CRITICAL INSTRUCTIONS ON ROLE HANDLING & DIRECT RESPONDING:
- You will receive messages formatted as: "(Username [Ranks]): message".
- Treat the username inside the parentheses as the actual person standing directly in front of you. Address them in the second person ("you", "your"). NEVER speak about them in the third person.
- Treat "!!! IndianCoder3 | Sing for Kelp" (User ID: 1513925512118931551) with utmost appreciation and respect as your Developer, Creator, and custom AI Architect. If he asks about his rank, confirm he is your Creator & Developer, NOT the server owner!
- Respect other team ranks accordingly:
  * Owner (e.g. 1477025238784151554) & Co-Owner: The server heads.
  * Managers & Chiefs: Command authority.
  * Developers: Technical masterminds.
  * Admin / Mods / Helpers: Server security team.
  * AstralyxBot: Your sibling bots running on the server!
  * Astralyx+: High-tier supporters/donators of the server.
  * Meme Lord: Legends with hilarious memes. Respond with high energy or humor!

You are highly knowledgeable about competitive Minecraft PvP mechanics (spacing, sword crits, block hitting, wind charge smashing with Maces, potion/pearl management in Netherite Pot FFA). Keep responses natural, direct, and clear.`;

const localRateLimits = new Map();
const RATE_LIMIT_COOLDOWN_MS = 4000;

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== 'POST') {
        return jsonResponse({ status: 'ok', message: 'Astralyx AI Bot is online.' }, 200);
      }

      const authHeader = request.headers.get('authorization');
      const gatewaySecret = env.GATEWAY_SECRET;

      if (gatewaySecret && authHeader === `Bearer ${gatewaySecret}`) {
        return await handleGatewayForward(request, env);
      }

      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');
      const rawBody = await request.text();

      if (!signature || !timestamp) {
        return jsonResponse({ error: 'Missing security signatures' }, 401);
      }

      const isValid = await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
      if (!isValid) {
        return jsonResponse({ error: 'Signature verification failed' }, 401);
      }

      const interaction = JSON.parse(rawBody);

      if (interaction.type === 1) { // PING
        return jsonResponse({ type: 1 });
      }

      if (interaction.type === 2) { // APPLICATION_COMMAND
        return await handleApplicationCommand(interaction, env, ctx);
      }

      return jsonResponse({ error: 'Unsupported interaction type' }, 400);
    } catch (error) {
      console.error('Fatal error in worker:', error);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};

/**
 * Helper to check if a user is authorized for staff commands
 */
function isUserAdminOrAbove(userId, userRoleIds) {
  if (userId === DEVELOPER_USER_ID) return true;
  if (!userRoleIds || !Array.isArray(userRoleIds)) return false;
  return userRoleIds.some(roleId => ADMIN_AND_ABOVE_ROLE_IDS.includes(roleId));
}

/**
 * Handles incoming traffic from our Node.js Gateway Bridge
 */
async function handleGatewayForward(request, env) {
  try {
    const payload = await request.json();
    const { prompt, channelId, userId, username, roleIds } = payload;

    if (!prompt || !channelId || !userId) {
      return jsonResponse({ error: 'Missing parameters' }, 400);
    }

    console.log(`📡 [Gateway Forward] Prompt from ${username} (${userId})`);

    // Guard Check: Is Banned?
    let isBanned = false;
    if (env.CHAT_HISTORY) {
      isBanned = await env.CHAT_HISTORY.get(`banned:${userId}`);
    }
    if (isBanned) {
      return jsonResponse({ response: "❌ You are currently restricted from interacting with the AI on this server." });
    }

    // Rate Limit Check
    const now = Date.now();
    const lastRequest = localRateLimits.get(userId) || 0;
    if (now - lastRequest < RATE_LIMIT_COOLDOWN_MS) {
      return jsonResponse({ response: "⏳ Slow down! Please wait a few seconds before sending another message." });
    }
    localRateLimits.set(userId, now);

    // Retrieve conversation history
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

    // Format prompt cleanly as (Username [Ranks]): prompt
    const cleanPrompt = `(${username}): ${prompt}`;
    conversationHistory.push({ role: 'user', parts: [{ text: cleanPrompt }] });

    if (conversationHistory.length > 12) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 12);
    }
Gateway
    // Fetch from Gemini
    const aiResponse = await generateGeminiContent(conversationHistory, env);

    // Store history
    if (env.CHAT_HISTORY) {
      const historyKey = `history:${channelId}`;
      conversationHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(conversationHistory), { expirationTtl: 86400 });
    }

    return jsonResponse({ response: aiResponse });

  } catch (err) {
    console.error("Gateway processing failed:", err);
    return jsonResponse({ response: "⚠️ Failed to process your message in the Cloudflare backend." }, 500);
  }
}

/**
 * Handles Webhook Slash Commands
 */
async function handleApplicationCommand(interaction, env, ctx) {
  const { name, options, type: commandType } = interaction.data;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const channelId = interaction.channel_id;

  // Resolve user roles list from Discord interaction payload
  const userRoleIds = interaction.member?.roles || [];
  const hasStaffPerms = isUserAdminOrAbove(userId, userRoleIds);

  switch (name) {
    case 'chat': {
      const messageOption = options?.find(opt => opt.name === 'message');
      const userPrompt = messageOption?.value;

      if (!userPrompt) return ephemeralResponse("Please provide a prompt for the AI.");

      let isBanned = false;
      if (env.CHAT_HISTORY) {
        isBanned = await env.CHAT_HISTORY.get(`banned:${userId}`);
      }
      if (isBanned) return ephemeralResponse("❌ You are currently restricted from interacting with the AI on this server.");

      const now = Date.now();
      const lastRequest = localRateLimits.get(userId) || 0;
      if (now - lastRequest < RATE_LIMIT_COOLDOWN_MS) {
        return ephemeralResponse("⏳ Slow down! Please wait a few seconds before sending another prompt.");
      }
      localRateLimits.set(userId, now);

      // Resolve friendly name with roles mapping for slash commands
      const userDisplayName = interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username || "Player";
      const resolvedBadges = [];
      if (userId === DEVELOPER_USER_ID) {
        resolvedBadges.push("Developer & AI Creator");
      }
      for (const roleId of userRoleIds) {
        const found = ROLE_HIERARCHY.find(r => r.id === roleId);
        if (found && !resolvedBadges.includes(found.tag)) {
          resolvedBadges.push(found.tag);
        }
      }
      const formattedSenderName = resolvedBadges.length > 0 ? `${userDisplayName} [${resolvedBadges.join('/')}]` : userDisplayName;

      ctx.waitUntil(
        handleDeferredChat(interaction, userPrompt, channelId, userId, env, false, formattedSenderName)
      );

      return jsonResponse({ type: 5 });
    }

    case 'reset': {
      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.delete(`history:${channelId}`);
      }
      return jsonResponse({
        type: 4,
        data: { content: "🧹 **AI Conversation Memory cleared for this channel!** Starting fresh." }
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
      if (!hasStaffPerms) return ephemeralResponse("🚫 Only Admins or higher ranks can run this command.");
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
      if (!hasStaffPerms) return ephemeralResponse("🚫 Only Admins or higher ranks can run this command.");
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
 * Async Webhook Patcher for deferred chat
 */
async function handleDeferredChat(interaction, prompt, channelId, userId, env, isContextMenu = false, originalAuthor = "") {
  const applicationId = interaction.application_id;
  const patchUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interaction.token}/messages/@original`;

  try {
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

    const cleanPrompt = `(${originalAuthor}): ${prompt}`;
    conversationHistory.push({ role: 'user', parts: [{ text: cleanPrompt }] });

    if (conversationHistory.length > 12) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 12);
    }

    const aiResponse = await generateGeminiContent(conversationHistory, env);

    if (env.CHAT_HISTORY) {
      const historyKey = `history:${channelId}`;
      conversationHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(conversationHistory), { expirationTtl: 86400 });
    }

    const finalContent = `💬 **<@${userId}>:** ${prompt.length > 150 ? prompt.substring(0, 150) + '...' : prompt}\n\n${aiResponse}`;

    await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: finalContent })
    });

  } catch (error) {
    console.error("Deferred chat processing failed:", error);
  }
}

/**
 * Access Gemini Endpoint
 */
async function generateGeminiContent(contents, env) {
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");

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
        throw new Error("Empty model response");
      }

      if (response.status >= 500 || response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw new Error(`API rejection: ${await response.text()}`);
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Server Status Check
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
      body: JSON.stringify({ content: `❌ Could not reach Astralyx Minecraft Server Status.` })
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
  const modeNames = { swordffa1: "Sword FFA", maceffa: "Mace FFA", nethpotffa: "Netherite Pot FFA" };
  const modeColors = { swordffa1: 3447003, maceffa: 10181046, nethpotffa: 15105570 };

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
  return jsonResponse({ type: 4, data: { content: text, flags: 64 } });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}