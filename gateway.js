/**
 * AstralyxAI Gateway Bridge
 * Standalone legacy gateway. The AstralyxBridge plugin replaces this service.
 *
 * Required environment variables:
 *   DISCORD_TOKEN   = gateway bot token (NOT the main bot token)
 *   WORKER_URL      = https://discord-ai-bot.indiancoder3.workers.dev/
 *   GATEWAY_SECRET  = shared secret between this gateway and the Worker
 */

import { Client, GatewayIntentBits } from 'discord.js';
import fetch from 'node-fetch';
import 'dotenv/config';

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const WORKER_URL     = process.env.WORKER_URL;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;

// Main AstralyxAI bot ID — gateway listens for replies to THIS bot
const MAIN_BOT_ID = '1516738646999302205';
const DEVELOPER_USER_ID = '1513925512118931551';

const ROLE_MAP = [
  { id: '1477025238784151554', tag: 'Owner' },
  { id: '1477291491003994214', tag: 'Co-Owner' },
  { id: '1502815102716608552', tag: 'Chief Manager' },
  { id: '1497335106074050620', tag: 'Sr. Manager' },
  { id: '1483209618485284964', tag: 'Manager' },
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
  { id: '1484284923794685992', tag: 'Meme Lord' }
];

if (!DISCORD_TOKEN || !WORKER_URL || !GATEWAY_SECRET) {
  console.error('❌ Missing DISCORD_TOKEN, WORKER_URL, or GATEWAY_SECRET!');
  process.exit(1);
}

// ============================================
// DISCORD GATEWAY CLIENT
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`✅ AstralyxAI Gateway online — logged in as ${client.user.tag}`);
  console.log(`👁️  Watching for pings and replies to main bot (${MAIN_BOT_ID})`);
});

function resolveUserBadges(message) {
  const userId = message.author.id;
  const badges = [];

  if (userId === DEVELOPER_USER_ID) {
    badges.push('Developer & AI Creator');
  }

  if (message.member) {
    const roleIds = message.member.roles.cache.map(r => r.id);
    for (const item of ROLE_MAP) {
      if (roleIds.includes(item.id)) {
        if (item.tag === 'Developer' && userId === DEVELOPER_USER_ID) continue;
        badges.push(item.tag);
      }
    }
  }

  return badges;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const gatewayMention  = `<@${client.user.id}>`;
  const gatewayMention2 = `<@!${client.user.id}>`;

  const isPingingGateway   = message.content.includes(gatewayMention) || message.content.includes(gatewayMention2);
  const isReplyingToMainBot = message.reference && message.mentions.repliedUser?.id === MAIN_BOT_ID;

  if (!isPingingGateway && !isReplyingToMainBot) return;

  const userDisplayName = message.member?.displayName || message.author.globalName || message.author.username;
  const badges = resolveUserBadges(message);
  const badgeSuffix = badges.length > 0 ? ` [${badges.join('/')}]` : '';
  const formattedName = `${userDisplayName}${badgeSuffix}`;
  const rawRoleIds = message.member?.roles.cache.map(r => r.id) || [];

  let cleanPrompt = message.content
    .replace(gatewayMention, '')
    .replace(gatewayMention2, '')
    .trim();

  if (!cleanPrompt) return;

  console.log(`💬 Forwarding from ${formattedName}: "${cleanPrompt.substring(0, 80)}..."`);

  try {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_SECRET}`
      },
      body: JSON.stringify({
        prompt: cleanPrompt,
        channelId: message.channel.id,
        userId: message.author.id,
        username: formattedName,
        roleIds: rawRoleIds,
        replyToMessageId: message.id
      })
    });

    if (!response.ok) {
      console.error(`❌ Worker responded with status ${response.status}`);
    } else {
      console.log(`✅ Forwarded successfully`);
    }

  } catch (err) {
    console.error('❌ Failed to reach Worker:', err.message);
  }
});

client.login(DISCORD_TOKEN);
