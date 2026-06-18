/**
 * AstralyxPvP Discord AI Gateway Bridge - Cloudflare Worker Edition
 * This worker runs on Cloudflare and maintains a persistent WebSocket connection
 * to the Discord Gateway, forwarding pings and replies to your main AI Worker.
 */

// Configuration Map of snowflake IDs to clean role tags
const ROLE_MAP = [
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
  { id: '1477025683061604432', tag: 'YouTube' },
  { id: '1497315976017084457', tag: 'Astralyx+' },
  { id: '1477031144426836183', tag: 'AstralyxBot' },
  { id: '1484285067218911493', tag: 'Chat Assistant' },
  { id: '1484284923794685992', tag: 'Meme Lord' }
];

const DEVELOPER_USER_ID = "1513925512118931551";

export default {
  async fetch(request, env, ctx) {
    // This endpoint allows you to trigger/warm up the connection via a simple Web request or cron trigger
    if (request.url.endsWith("/connect") || request.method === "GET") {
      try {
        await establishDiscordConnection(env, ctx);
        return new Response("WebSocket connection initiated on Cloudflare!", { status: 200 });
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }
    return new Response("Cloudflare Gateway Worker is running.", { status: 200 });
  },

  // Automatically keep the connection alive using Cloudflare Cron Triggers (run every 1-5 minutes)
  async scheduled(event, env, ctx) {
    console.log("⏰ Cron Trigger: Ensuring Discord Gateway WebSocket is alive...");
    ctx.waitUntil(establishDiscordConnection(env, ctx));
  }
};

let globalWebSocket = null;
let heartbeatInterval = null;
let sequenceNumber = null;
let sessionId = null;

async function establishDiscordConnection(env, ctx) {
  if (globalWebSocket && globalWebSocket.readyState === 1) {
    console.log("🟢 Gateway is already connected and active.");
    return;
  }

  const token = env.DISCORD_TOKEN;
  // Use https:// instead of wss:// for Cloudflare fetch outbound upgrade handshakes
  const gatewayUrl = "https://gateway.discord.gg/?v=10&encoding=json";

  console.log("🔌 Connecting to Discord Gateway via Cloudflare WebSockets...");
  
  // Create a WebSocket connection using Cloudflare's outbound WebSocket feature
  const resp = await fetch(gatewayUrl, {
    headers: {
      "Upgrade": "websocket",
    },
  });

  const ws = resp.webSocket;
  if (!ws) {
    throw new Error("Cloudflare failed to upgrade connection to WebSocket.");
  }

  // CRITICAL FIX: Removed ws.accept() since this is an outbound CLIENT socket.
  // Calling accept() here was causing immediate script termination on Cloudflare.
  globalWebSocket = ws;

  ws.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      const { op, d, s, t } = payload;

      if (s) sequenceNumber = s;

      switch (op) {
        case 10: // Hello Event
          const heartbeatMs = d.heartbeat_interval;
          startHeartbeat(ws, heartbeatMs);
          identifyConnection(ws, token);
          break;

        case 11: // Heartbeat ACK
          console.log("💓 Heartbeat acknowledged by Discord.");
          break;

        case 0: // Dispatch Event
          if (t === "READY") {
            sessionId = d.session_id;
            console.log(`🤖 Logged in as ${d.user.username} via Cloudflare!`);
          } else if (t === "MESSAGE_CREATE") {
            ctx.waitUntil(handleMessageCreate(d, env, d.user.id));
          }
          break;

        case 9: // Invalid Session
          console.warn("⚠️ Invalid Session. Reconnecting...");
          ws.close();
          break;
      }
    } catch (err) {
      console.error("Error parsing socket payload:", err);
    }
  });

  ws.addEventListener("close", (e) => {
    console.log(`🔴 WebSocket disconnected: ${e.reason} (${e.code})`);
    clearInterval(heartbeatInterval);
  });
}

function startHeartbeat(ws, intervalMs) {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ op: 1, d: sequenceNumber }));
    }
  }, intervalMs);
}

function identifyConnection(ws, token) {
  const payload = {
    op: 2,
    d: {
      token: token,
      intents: 33280, // Guilds, Guild Messages, Message Content
      properties: {
        os: "cloudflare-worker",
        browser: "cloudflare",
        device: "cloudflare"
      }
    }
  };
  ws.send(JSON.stringify(payload));
}

/**
 * Handle incoming message creations just like your local PC did!
 */
async function handleMessageCreate(message, env, botUserId) {
  if (message.author.bot) return;

  const botMention = `<@${botUserId}>`;
  const nicknameMention = `<@!${botUserId}>`;
  const isMentioned = message.content.includes(botMention) || message.content.includes(nicknameMention);
  const isReplyToBot = message.referenced_message && message.referenced_message.author.id === botUserId;

  if (isMentioned || isReplyToBot) {
    // Fetch member and displayName safely
    const username = message.member?.nick || message.author.global_name || message.author.username;
    
    // Resolve clean badges
    const badges = [];
    if (message.author.id === DEVELOPER_USER_ID) {
      badges.push("Developer & AI Creator");
    }

    const roleIds = message.member?.roles || [];
    for (const item of ROLE_MAP) {
      if (roleIds.includes(item.id)) {
        if (item.tag === 'Developer' && message.author.id === DEVELOPER_USER_ID) continue;
        badges.push(item.tag);
      }
    }

    const badgeSuffix = badges.length > 0 ? ` [${badges.join('/')}]` : "";
    const finalFormattedName = `${username}${badgeSuffix}`;

    console.log(`💬 forwarding direct trigger to main brain: ${finalFormattedName}`);

    // Clean mention content
    let cleanPrompt = message.content
      .replace(botMention, "")
      .replace(nicknameMention, "")
      .trim();

    if (!cleanPrompt) {
      await sendReply(message.channel_id, message.id, `Hey ${username}! What can I help you with today?`, env);
      return;
    }

    try {
      // Trigger a raw fetch back to your Main Worker!
      const response = await fetch(env.WORKER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.GATEWAY_SECRET}`
        },
        body: JSON.stringify({
          prompt: cleanPrompt,
          channelId: message.channel_id,
          userId: message.author.id,
          username: finalFormattedName,
          roleIds: roleIds
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.response) {
          await sendReply(message.channel_id, message.id, data.response, env);
        }
      }
    } catch (err) {
      console.error("Failed to forward to AI Worker:", err);
    }
  }
}

async function sendReply(channelId, messageId, content, env) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: content,
      message_reference: {
        message_id: messageId
      }
    })
  });
}