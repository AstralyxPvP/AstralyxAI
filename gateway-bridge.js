/**
 * AstralyxPvP Discord AI Gateway Bridge
 * Run this on any 24/7 machine (your PC, home server, or VPS).
 * It listens to direct @mentions in Discord and safely forwards them to your Cloudflare Worker!
 */

import { Client, GatewayIntentBits } from 'discord.js';
import fetch from 'node-fetch'; // If node-fetch isn't installed automatically, run: npm install node-fetch
import 'dotenv/config';

// 1. Get configurations from your .env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WORKER_URL = process.env.WORKER_URL; // Your Cloudflare Worker URL (e.g. https://discord-ai-bot.indiancoder3.workers.dev)
const GATEWAY_SECRET = process.env.GATEWAY_SECRET; // Must match the secret set in Cloudflare secrets!

if (!DISCORD_TOKEN || !WORKER_URL || !GATEWAY_SECRET) {
  console.error("❌ ERROR: Missing DISCORD_TOKEN, WORKER_URL, or GATEWAY_SECRET inside your .env file!");
  process.exit(1);
}

// 2. Initialize Discord Client with message reading intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`🤖 SUCCESS: Gateway Bridge is online! Logged in as: ${client.user.tag}`);
  console.log(`🔗 Forwarding mentions securely to: ${WORKER_URL}`);
});

client.on('messageCreate', async (message) => {
  // Prevent bot replying to itself or other bots
  if (message.author.bot) return;

  // Check if the message contains a direct mention to this bot
  const botMention = `<@${client.user.id}>`;
  const nicknameMention = `<@!${client.user.id}>`;

  if (message.content.includes(botMention) || message.content.includes(nicknameMention)) {
    console.log(`💬 Mention received in #${message.channel.name} from ${message.author.username}`);

    try {
      // Clean the mention out of the text content
      let cleanPrompt = message.content
        .replace(botMention, "")
        .replace(nicknameMention, "")
        .trim();

      if (!cleanPrompt) {
        message.reply("Hey! What can I help you with today? (Usage: `@AstralyxAI <your prompt>`)");
        return;
      }

      // Show native typing indicator in Discord so users know the bot is thinking
      await message.channel.sendTyping();

      // Forward to Cloudflare Worker with Secure Authentication Header
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
          username: message.author.username
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.response) {
          // Reply directly to the user's mention on Discord
          await message.reply(data.response);
        } else {
          await message.reply("⚠️ Received an empty response from the Cloudflare brain.");
        }
      } else {
        console.error(`❌ Worker request failed with status: ${response.status}`);
        const errText = await response.text();
        console.error(errText);
        await message.reply("❌ The Cloudflare AI Worker returned an error while processing.");
      }

    } catch (error) {
      console.error("❌ Error during gateway handling:", error);
      await message.reply("❌ Failed to reach the Cloudflare AI brain right now. Is the Worker online?");
    }
  }
});

// Start the WebSocket Gateway
client.login(DISCORD_TOKEN);