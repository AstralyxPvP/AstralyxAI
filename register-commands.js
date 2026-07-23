// Run this once (and again any time you change command definitions) with:
//   node register-commands.js

import 'dotenv/config';

const commands = [
  {
    name: 'chat',
    description: 'Chat with the Astralyx PvP AI companion',
    options: [
      {
        name: 'message',
        description: 'What do you want to ask or say to the AI?',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'reset',
    description: 'Clear the AI conversation memory for this channel',
  },
  {
    name: 'lb',
    description: 'View the ELO leaderboard for a gamemode',
    options: [
      {
        name: 'gamemode',
        description: 'Gamemode',
        type: 3, // String
        required: true,
        autocomplete: true, // 👈 Replaces hardcoded choices
      },
      {
        name: 'page',
        description: 'Page',
        type: 4, // Integer
        required: false,
      },
    ],
  },
  {
    name: 'mconline',
    description: 'Check if the Minecraft server is online',
  },
  {
    name: 'elostats',
    description: 'Look up a player\'s ELO across all gamemodes',
    options: [
      {
        name: 'player',
        description: 'The player username',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'aiban',
    description: 'Restrict a user from using the AI (Staff only)',
    options: [
      {
        name: 'user',
        description: 'The user to restrict',
        type: 6, // USER
        required: true,
      },
    ],
  },
  {
    name: 'aiunban',
    description: 'Unrestrict a user from using the AI (Staff only)',
    options: [
      {
        name: 'user',
        description: 'The user to unrestrict',
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: 'link',
    description: 'Link your Minecraft account to Discord',
    options: [
      {
        name: 'username',
        description: 'Your Minecraft username',
        type: 3,
        required: true,
      },
      {
        name: 'code',
        description: 'The link code from /linkaccount in-game',
        type: 3,
        required: true,
      },
    ],
  },
];

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_TOKEN in your .env file.');
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

const response = await fetch(url, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bot ${BOT_TOKEN}`,
  },
  body: JSON.stringify(commands),
});

if (response.ok) {
  const names = commands.map(c => `/${c.name}`).join(', ');
  console.log(`Successfully registered ${names}.`);
} else {
  console.error('Error registering commands:', response.status);
  console.error(await response.text());
  process.exit(1);
}