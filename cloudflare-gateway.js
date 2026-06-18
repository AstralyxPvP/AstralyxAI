/**
 * AstralyxPvP Discord AI Gateway Bridge - Cloudflare Worker Edition
 * Maintains a persistent WebSocket connection to the Discord Gateway,
 * and streams real-time console logs securely using isolated context polling.
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

// Global, isolated logging buffer
const logsBuffer = [];
const MAX_LOGS_LIMIT = 100;

// Tracking global lifecycle contexts
let globalCtx = null;
let globalWebSocket = null;
let heartbeatInterval = null;
let sequenceNumber = null;
let sessionId = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    globalCtx = ctx; // Cache active context safely

    // Endpoint to stream raw logs back to our browser terminal safely
    if (url.pathname === "/connect/stream") {
      let intervalId = null;

      const stream = new ReadableStream({
        start(controller) {
          broadcastLog("🚀 [Gateway System] Log streaming channel opened successfully.");
          
          // Poll the global logs buffer inside the context of the CURRENT request
          let lastSeenIndex = 0;
          
          intervalId = setInterval(() => {
            while (lastSeenIndex < logsBuffer.length) {
              const log = logsBuffer[lastSeenIndex++];
              try {
                controller.enqueue(new TextEncoder().encode(`data: ${log}\n\n`));
              } catch (err) {
                // Client closed stream connection
                clearInterval(intervalId);
                break;
              }
            }
          }, 400);

          // Force background check and connection trigger on stream load
          ctx.waitUntil(
            establishDiscordConnection(env, ctx).catch(err => {
              broadcastLog(`❌ [Connection Error] ${err.message}`);
            })
          );
        },
        cancel() {
          if (intervalId) clearInterval(intervalId);
          console.log("🔌 Live stream client closed.");
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Serve a premium web terminal interface on /connect
    if (url.pathname === "/connect" || url.pathname === "/connect/") {
      return new Response(getTerminalHTML(), {
        headers: { "Content-Type": "text/html" }
      });
    }

    return new Response("Cloudflare Gateway Worker is running. Visit /connect to see live console.", { status: 200 });
  },

  // Keep gateway active in background with cron checks
  async scheduled(event, env, ctx) {
    globalCtx = ctx;
    broadcastLog("⏰ [Cron Trigger] Running periodic connection validation check...");
    ctx.waitUntil(establishDiscordConnection(env, ctx));
  }
};

/**
 * Appends messages safely to the global queue
 */
function broadcastLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const formattedLog = `[${timestamp}] ${message}`;
  
  console.log(formattedLog);

  logsBuffer.push(formattedLog);
  if (logsBuffer.length > MAX_LOGS_LIMIT) {
    logsBuffer.shift(); // Evict oldest log line
  }
}

async function establishDiscordConnection(env, ctx) {
  if (globalWebSocket && globalWebSocket.readyState === 1) {
    broadcastLog("🟢 [Gateway Monitor] Connection is active and healthy.");
    return;
  }

  const token = env.DISCORD_TOKEN;
  const gatewayUrl = "https://gateway.discord.gg/?v=10&encoding=json";

  broadcastLog("🔌 [Gateway Connection] Initiating outbound WebSocket client to Discord...");
  
  const resp = await fetch(gatewayUrl, {
    headers: {
      "Upgrade": "websocket",
    },
  });

  const ws = resp.webSocket;
  if (!ws) {
    throw new Error("Outbound socket upgrade failed. Verify Cloudflare Worker permissions.");
  }

  // REQUIRED FOR OUTBOUND WEBSOCKET CLOUDFLARE CLIENTS
  ws.accept();
  globalWebSocket = ws;

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const { op, d, s, t } = payload;

      if (s) sequenceNumber = s;

      switch (op) {
        case 10: // Hello
          const heartbeatMs = d.heartbeat_interval;
          startHeartbeat(ws, heartbeatMs);
          identifyConnection(ws, token);
          break;

        case 11: // Heartbeat ACK
          broadcastLog("💓 [Heartbeat] Discord acknowledged gateway health check.");
          break;

        case 0: // Dispatch
          if (t === "READY") {
            sessionId = d.session_id;
            broadcastLog(`🤖 [Success] Discord validated gateway. Bot is online!`);
          } else if (t === "MESSAGE_CREATE") {
            // Safely execute handleMessageCreate using active context
            if (globalCtx && globalCtx.waitUntil) {
              globalCtx.waitUntil(handleMessageCreate(d, env, d.user.id));
            } else {
              handleMessageCreate(d, env, d.user.id);
            }
          }
          break;

        case 9: // Invalid Session
          broadcastLog("⚠️ [Gateway Warning] Session flagged as invalid. Reconnecting...");
          ws.close();
          break;
      }
    } catch (err) {
      console.error("Error parsing socket payload:", err);
    }
  });

  ws.addEventListener("close", (e) => {
    broadcastLog(`🔴 [Disconnect] Socket closed by remote host: ${e.reason} (Code: ${e.code})`);
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
 * Handle incoming message creations
 */
async function handleMessageCreate(message, env, botUserId) {
  if (message.author.bot) return;

  const botMention = `<@${botUserId}>`;
  const nicknameMention = `<@!${botUserId}>`;
  const isMentioned = message.content.includes(botMention) || message.content.includes(nicknameMention);
  const isReplyToBot = message.referenced_message && message.referenced_message.author.id === botUserId;

  if (isMentioned || isReplyToBot) {
    const username = message.member?.nick || message.author.global_name || message.author.username;
    
    // Resolve tags
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

    broadcastLog(`💬 [Forwarding Message] "${message.content}" from user: ${finalFormattedName}`);

    let cleanPrompt = message.content
      .replace(botMention, "")
      .replace(nicknameMention, "")
      .trim();

    if (!cleanPrompt) {
      await sendReply(message.channel_id, message.id, `Hey ${username}! What can I help you with today?`, env);
      return;
    }

    try {
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
          broadcastLog(`✨ [Responding] AI Main Brain: "${data.response.substring(0, 50)}..."`);
          await sendReply(message.channel_id, message.id, data.response, env);
        }
      } else {
        broadcastLog(`❌ [AI Error] Main Brain Worker status code: ${response.status}`);
      }
    } catch (err) {
      broadcastLog(`❌ [API Fail] Could not fetch to main Worker: ${err.message}`);
    }
  }
}

async function sendReply(channelId, messageId, content, env) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const res = await fetch(url, {
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
  if (!res.ok) {
    broadcastLog(`❌ [Discord Reply Error] Failed sending message: ${res.status}`);
  }
}

/**
 * Returns a beautiful modern dark theme HTML page with automatic live console streaming
 */
function getTerminalHTML() {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AstralyxAI - Core Control Console</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        background-color: #0d1117;
        font-family: 'Courier New', Courier, monospace;
        color: #c9d1d9;
        display: flex;
        flex-direction: column;
        height: 90vh;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 2px solid #30363d;
        padding-bottom: 15px;
        margin-bottom: 15px;
      }
      .logo {
        font-size: 24px;
        font-weight: bold;
        color: #ff9800;
        text-shadow: 0 0 8px rgba(255, 152, 0, 0.4);
      }
      .status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background-color: #ff9800;
        box-shadow: 0 0 8px #ff9800;
      }
      .dot.online {
        background-color: #2ea043;
        box-shadow: 0 0 8px #2ea043;
      }
      .dot.offline {
        background-color: #f85149;
        box-shadow: 0 0 8px #f85149;
      }
      .terminal {
        background-color: #161b22;
        border: 1px solid #30363d;
        border-radius: 6px;
        flex-grow: 1;
        padding: 15px;
        overflow-y: auto;
        white-space: pre-wrap;
        box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
        font-size: 14px;
        line-height: 1.5;
      }
      .line {
        margin-bottom: 6px;
        border-left: 2px solid transparent;
        padding-left: 8px;
      }
      .system { color: #58a6ff; }
      .success { color: #56d364; }
      .error { color: #f85149; }
      .message { color: #ff7b72; }
      .timestamp { color: #8b949e; margin-right: 8px; }
      .footer {
        margin-top: 15px;
        display: flex;
        justify-content: space-between;
        color: #8b949e;
        font-size: 12px;
      }
      .btn {
        background-color: #21262d;
        border: 1px solid #30363d;
        color: #c9d1d9;
        padding: 5px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn:hover {
        background-color: #30363d;
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="logo">⚡ AstralyxAI Core Console</div>
      <div class="status">
        <div id="statusDot" class="dot"></div>
        <span id="statusText">Connecting...</span>
      </div>
    </div>
    <div id="terminal" class="terminal"></div>
    <div class="footer">
      <div>Platform: Cloudflare Serverless Engine</div>
      <button class="btn" onclick="clearConsole()">Clear Console</button>
    </div>

    <script>
      const terminal = document.getElementById("terminal");
      const statusDot = document.getElementById("statusDot");
      const statusText = document.getElementById("statusText");

      function appendLog(text) {
        const line = document.createElement("div");
        line.className = "line";

        // Simple formatting helper
        if (text.includes("[Gateway System]")) {
          line.classList.add("system");
        } else if (text.includes("[Success]") || text.includes("🟢") || text.includes("✨")) {
          line.classList.add("success");
        } else if (text.includes("❌") || text.includes("🔴")) {
          line.classList.add("error");
        } else if (text.includes("💬")) {
          line.classList.add("message");
        }

        line.textContent = text;
        terminal.appendChild(line);
        terminal.scrollTop = terminal.scrollHeight;
      }

      function clearConsole() {
        terminal.innerHTML = "";
        appendLog("[System] Console cleared.");
      }

      function startStream() {
        statusDot.className = "dot";
        statusText.textContent = "Connecting stream...";
        
        const eventSource = new EventSource("/connect/stream");

        eventSource.onopen = () => {
          statusDot.className = "dot online";
          statusText.textContent = "Gateway Stream Connected";
          appendLog("[System] EventSource active. Connection pre-warmed.");
        };

        eventSource.onmessage = (event) => {
          appendLog(event.data);
        };

        eventSource.onerror = (error) => {
          statusDot.className = "dot offline";
          statusText.textContent = "Stream Disconnected (Reconnecting...)";
          eventSource.close();
          // Auto reconnect after 3 seconds
          setTimeout(startStream, 3000);
        };
      }

      // Start SSE log streaming when loading page
      startStream();
    </script>
  </body>
  </html>
  `;
}