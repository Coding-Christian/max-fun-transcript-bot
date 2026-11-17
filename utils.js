import 'dotenv/config';

export async function DiscordRequest(endpoint, options) {
  // append endpoint to root API URL
  const url = 'https://discord.com/api/v10/' + endpoint;
  // Stringify payloads
  if (options.body) options.body = JSON.stringify(options.body);
  // Use fetch to make requests
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
    },
    ...options
  });
  // throw API errors
  if (!res.ok) {
    const data = await res.json();
    console.log(res.status);
    throw new Error(JSON.stringify(data));
  }
  // return original response
  return res;
}

export async function InstallGlobalCommands(appId, commands) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Command registration requires Node.js 18.4 or newer. Run `nvm use` (or select Node.js 20), then retry `npm run register`.');
  }
  if (!appId || !process.env.DISCORD_TOKEN) {
    throw new Error('Set APP_ID and DISCORD_TOKEN in .env before registering commands.');
  }
  // API endpoint to overwrite global commands
  const endpoint = `applications/${appId}/commands`;

  // Discord returns the registered commands so callers can confirm success.
  const response = await DiscordRequest(endpoint, { method: 'PUT', body: commands });
  return response.json();
}

// Simple method that returns a random emoji from list
export function getRandomEmoji() {
  const emojiList = ['😭','😄','😌','🤓','😎','😤','🤖','😶‍🌫️','🌏','📸','💿','👋','🌊','✨'];
  return emojiList[Math.floor(Math.random() * emojiList.length)];
}
