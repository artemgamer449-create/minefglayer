const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalLookAtBlock } = goals;

const host = process.env.BOT_HOST || 'ghjghjghjghjdfg-M3DJ.aternos.me';
const port = parseInt(process.env.BOT_PORT) || 41441;
const version = process.env.BOT_VERSION || '1.21.11';
const username = process.env.BOT_USERNAME || 'bot';
const auth = process.env.BOT_AUTH || 'offline';
const password = process.env.BOT_PASSWORD || 'botpassword';
const autoReconnect = process.env.BOT_AUTO_RECONNECT !== 'false';
const antiAfk = process.env.BOT_ANTI_AFK !== 'false';

const bot = mineflayer.createBot({
  host,
  port,
  username,
  version,
  auth
});

bot.loadPlugin(pathfinder);

const defaultMove = new Movements(bot);

let isSpawned = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;

function startAntiAfk() {
  if (isSpawned || !antiAfk) return;
  isSpawned = true;

  setInterval(() => {
    if (!bot.entity) return;

    const action = Math.floor(Math.random() * 5);

    switch (action) {
      case 0:
        bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI, true);
        break;
      case 1:
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 500);
        break;
      case 2:
        bot.setControlState('forward', true);
        setTimeout(() => bot.setControlState('forward', false), 1000);
        break;
      case 3:
        bot.setControlState('back', true);
        setTimeout(() => bot.setControlState('back', false), 1000);
        break;
      case 4:
        bot.swingArm('right');
        break;
    }
  }, Math.random() * 30000 + 30000);

  setInterval(() => {
    if (!bot.entity) return;
    bot.chat(`/afk`);
  }, 300000);
}

function handleReconnect() {
  if (!autoReconnect) return;
  if (reconnectAttempts >= maxReconnectAttempts) {
    console.log('Max reconnect attempts reached');
    process.exit(1);
  }
  reconnectAttempts++;
  console.log(`Reconnecting... (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
  setTimeout(() => process.exit(1), 5000);
}

bot.once('spawn', () => {
  console.log(`Bot spawned on server! (${username}@${host}:${port})`);
  reconnectAttempts = 0;
  startAntiAfk();
});

bot.on('login', () => {
  console.log('Bot logged in');
  if (auth === 'offline' && password) {
    bot.chat(`/register ${password} ${password}`);
    setTimeout(() => bot.chat(`/login ${password}`), 2000);
  }
});

bot.on('kicked', (reason) => {
  console.log('Kicked:', reason);
  isSpawned = false;
  handleReconnect();
});

bot.on('end', () => {
  console.log('Disconnected');
  isSpawned = false;
  handleReconnect();
});

bot.on('error', (err) => {
  console.log('Error:', err.message);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  if (message === '!ping') {
    bot.chat('pong');
  }
});

process.stdin.on('data', data => {
  const cmd = data.toString().trim();
  if (!cmd) return;
  bot.chat(cmd);
});

process.on('uncaughtException', (err) => {
  console.log('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err);
});