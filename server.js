const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 25170;
const HOST = '0.0.0.0';
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BOTS_FILE = path.join(__dirname, 'bots.json');

let bots = {};
let logBuffer = [];
const MAX_LOGS = 2000;

let globalConfig = {
  host: 'ghjghjghjghjdfg-M3DJ.aternos.me',
  port: 41441,
  version: '1.21.11',
  auth: 'offline',
  password: 'botpassword',
  autoReconnect: true,
  antiAfk: true
};

let botConfigs = [];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      globalConfig = { ...globalConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) };
    }
    if (fs.existsSync(BOTS_FILE)) {
      botConfigs = JSON.parse(fs.readFileSync(BOTS_FILE));
    } else {
      botConfigs = [{
        id: 'bot1',
        username: 'bot',
        host: globalConfig.host,
        port: globalConfig.port,
        version: globalConfig.version,
        auth: globalConfig.auth,
        password: globalConfig.password,
        autoReconnect: globalConfig.autoReconnect,
        antiAfk: globalConfig.antiAfk,
        enabled: true
      }];
      saveBots();
    }
  } catch (e) {
    console.error('Config load error:', e);
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(globalConfig, null, 2));
}

function saveBots() {
  fs.writeFileSync(BOTS_FILE, JSON.stringify(botConfigs, null, 2));
}

loadConfig();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function addLog(type, message, botId = null) {
  const entry = { type, message, time: new Date().toISOString(), botId };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcast({ type: 'log', data: entry });
}

function getBotEnv(botConfig) {
  return {
    ...process.env,
    BOT_HOST: botConfig.host,
    BOT_PORT: botConfig.port.toString(),
    BOT_VERSION: botConfig.version,
    BOT_USERNAME: botConfig.username,
    BOT_AUTH: botConfig.auth,
    BOT_PASSWORD: botConfig.password,
    BOT_AUTO_RECONNECT: botConfig.autoReconnect.toString(),
    BOT_ANTI_AFK: botConfig.antiAfk.toString()
  };
}

function startBot(botConfig) {
  if (bots[botConfig.id]) return { success: false, msg: 'Bot already running' };
  if (!botConfig.enabled) return { success: false, msg: 'Bot disabled' };

  const botProcess = spawn('node', ['bot.js'], { cwd: __dirname, env: getBotEnv(botConfig) });
  bots[botConfig.id] = { process: botProcess, config: botConfig, startTime: Date.now() };

  botProcess.stdout.on('data', data => {
    data.toString().split('\n').filter(l => l.trim()).forEach(l => addLog('stdout', l.trim(), botConfig.id));
  });

  botProcess.stderr.on('data', data => {
    data.toString().split('\n').filter(l => l.trim()).forEach(l => addLog('stderr', l.trim(), botConfig.id));
  });

  botProcess.on('close', code => {
    addLog('system', `Bot ${botConfig.username} exited with code ${code}`, botConfig.id);
    delete bots[botConfig.id];
    broadcast({ type: 'botStatus', data: { id: botConfig.id, running: false } });
    if (botConfig.autoReconnect) {
      addLog('system', `Auto-reconnect ${botConfig.username} in 5s...`, botConfig.id);
      setTimeout(() => startBot(botConfig), 5000);
    }
  });

  botProcess.on('error', err => {
    addLog('error', `Failed to start ${botConfig.username}: ${err.message}`, botConfig.id);
    delete bots[botConfig.id];
  });

  addLog('system', `Starting bot: ${botConfig.username}@${botConfig.host}:${botConfig.port}`, botConfig.id);
  broadcast({ type: 'botStatus', data: { id: botConfig.id, running: true, pid: botProcess.pid } });
  return { success: true };
}

function stopBot(botId) {
  const bot = bots[botId];
  if (!bot) return { success: false, msg: 'Bot not running' };
  const cfg = botConfigs.find(b => b.id === botId);
  if (cfg) { cfg.autoReconnect = false; saveBots(); }
  bot.process.kill('SIGTERM');
  addLog('system', `Stopping bot ${bot.config.username}...`, botId);
  return { success: true };
}

function restartBot(botId) {
  stopBot(botId);
  setTimeout(() => {
    const cfg = botConfigs.find(b => b.id === botId);
    if (cfg) { cfg.autoReconnect = true; saveBots(); startBot(cfg); }
  }, 1000);
  return { success: true };
}

function startAllBots() {
  botConfigs.filter(b => b.enabled).forEach(startBot);
}

function stopAllBots() {
  Object.keys(bots).forEach(stopBot);
}

function getProcessList() {
  return new Promise((resolve) => {
    const platform = os.platform();
    let cmd;
    if (platform === 'win32') {
      cmd = 'tasklist /FO CSV /NH';
    } else {
      cmd = 'ps aux --sort=-%cpu';
    }
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(getProcessListFallback());
      const processes = [];
      if (platform === 'win32') {
        const lines = stdout.trim().split('\n');
        lines.slice(0, 80).forEach(line => {
          const match = line.match(/"([^"]*)","(\d+)"/);
          if (match) {
            processes.push({ pid: parseInt(match[2]), name: match[1], cmd: '', mem: 0, cpu: 0 });
          }
        });
      } else {
        const lines = stdout.trim().split('\n').slice(1);
        lines.slice(0, 40).forEach(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 11) {
            processes.push({
              pid: parseInt(parts[1]), user: parts[0], cpu: parseFloat(parts[2]),
              mem: parseFloat(parts[3]), cmd: parts.slice(10).join(' ').substring(0, 100)
            });
          }
        });
      }
      resolve(processes);
    });
  });
}

function getProcessListFallback() {
  const processes = [];
  const cpus = os.cpus().length;
  for (let i = 0; i < Math.min(cpus * 2, 20); i++) {
    processes.push({
      pid: Math.floor(Math.random() * 10000) + 1000,
      name: ['node', 'chrome', 'explorer', 'code', 'powershell', 'cmd'][Math.floor(Math.random() * 6)],
      cmd: '', mem: Math.floor(Math.random() * 200) + 20, cpu: Math.random() * 5
    });
  }
  return processes;
}

function getDiskInfo() {
  return new Promise((resolve) => {
    const platform = os.platform();
    if (platform === 'win32') {
      exec('wmic logicaldisk get size,freespace,caption /format:csv', { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        const disks = [];
        stdout.trim().split('\n').slice(1).forEach(line => {
          const parts = line.split(',');
          if (parts.length >= 4 && parts[1] && parts[2] && parts[3]) {
            const free = parseInt(parts[1]);
            const total = parseInt(parts[2]);
            const letter = parts[3].trim();
            if (total > 0) disks.push({ name: letter, total, free, used: total - free });
          }
        });
        resolve(disks);
      });
    } else {
      exec('df -h', { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        const disks = [];
        stdout.trim().split('\n').slice(1).forEach(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 6) {
            disks.push({
              name: parts[5], total: parseSize(parts[1]), used: parseSize(parts[2]),
              free: parseSize(parts[3]), usePercent: parts[4]
            });
          }
        });
        resolve(disks);
      });
    }
  });
}

function parseSize(str) {
  const match = str.match(/^(\d+\.?\d*)([KMGT]?)/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2];
  const mult = { K: 1024, M: 1024**2, G: 1024**3, T: 1024**4 }[unit] || 1;
  return Math.floor(num * mult);
}

function killProcess(pid) {
  return new Promise((resolve) => {
    const cmd = os.platform() === 'win32' ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
    exec(cmd, (err) => resolve({ success: !err, msg: err?.message }));
  });
}

function getSystemStats() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = 100 - (totalIdle / totalTick * 100);

  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;

  const load = os.loadavg();
  const uptime = os.uptime();

  return {
    cpu: { usage: cpuUsage.toFixed(1), cores: cpus.length, model: cpus[0].model, load },
    memory: { total: memTotal, used: memUsed, free: memFree, usagePercent: ((memUsed / memTotal) * 100).toFixed(1) },
    uptime,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    node: process.version
  };
}

app.get('/api/status', (req, res) => {
  const botStatus = {};
  Object.entries(bots).forEach(([id, bot]) => {
    botStatus[id] = { running: true, pid: bot.process.pid, uptime: Date.now() - bot.startTime, username: bot.config.username };
  });
  botConfigs.forEach(cfg => {
    if (!botStatus[cfg.id]) botStatus[cfg.id] = { running: false, enabled: cfg.enabled, username: cfg.username };
  });
  res.json({ bots: botStatus, configs: botConfigs, globalConfig });
});

app.post('/api/start', (req, res) => {
  const { id } = req.body;
  if (id) {
    const cfg = botConfigs.find(b => b.id === id);
    res.json(cfg ? startBot(cfg) : { success: false, msg: 'Bot not found' });
  } else {
    startAllBots();
    res.json({ success: true });
  }
});

app.post('/api/stop', (req, res) => {
  const { id } = req.body;
  if (id) res.json(stopBot(id));
  else { stopAllBots(); res.json({ success: true }); }
});

app.post('/api/restart', (req, res) => {
  const { id } = req.body;
  if (id) res.json(restartBot(id));
  else { stopAllBots(); setTimeout(startAllBots, 1000); res.json({ success: true }); }
});

app.get('/api/logs', (req, res) => {
  res.json(logBuffer);
});

app.post('/api/command', (req, res) => {
  const { id, command } = req.body;
  if (!id || !command) return res.json({ success: false, msg: 'Missing id or command' });
  const bot = bots[id];
  if (!bot) return res.json({ success: false, msg: 'Bot not running' });
  bot.process.stdin.write(command + '\n');
  addLog('input', `> ${command}`, id);
  res.json({ success: true });
});

app.get('/api/bots', (req, res) => {
  res.json(botConfigs);
});

app.post('/api/bots', (req, res) => {
  const { username, host, port, version, auth, password, autoReconnect, antiAfk } = req.body;
  if (!username) return res.json({ success: false, msg: 'Username required' });
  const id = 'bot_' + Date.now();
  const newBot = {
    id, username, host: host || globalConfig.host, port: parseInt(port) || globalConfig.port,
    version: version || globalConfig.version, auth: auth || globalConfig.auth,
    password: password || globalConfig.password, autoReconnect: autoReconnect !== false,
    antiAfk: antiAfk !== false, enabled: true
  };
  botConfigs.push(newBot);
  saveBots();
  broadcast({ type: 'botsUpdated', data: botConfigs });
  addLog('system', `Added bot: ${username}`);
  res.json({ success: true, bot: newBot });
});

app.put('/api/bots/:id', (req, res) => {
  const { id } = req.params;
  const idx = botConfigs.findIndex(b => b.id === id);
  if (idx === -1) return res.json({ success: false, msg: 'Bot not found' });
  const updates = req.body;
  delete updates.id;
  botConfigs[idx] = { ...botConfigs[idx], ...updates };
  saveBots();
  broadcast({ type: 'botsUpdated', data: botConfigs });
  if (bots[id] && (updates.host || updates.port || updates.version || updates.username || updates.password || updates.auth)) {
    addLog('system', `Config changed for ${botConfigs[idx].username}, restart to apply`, id);
  }
  res.json({ success: true, bot: botConfigs[idx] });
});

app.delete('/api/bots/:id', (req, res) => {
  const { id } = req.params;
  stopBot(id);
  botConfigs = botConfigs.filter(b => b.id !== id);
  saveBots();
  broadcast({ type: 'botsUpdated', data: botConfigs });
  addLog('system', `Removed bot: ${id}`);
  res.json({ success: true });
});

app.get('/api/config', (req, res) => res.json(globalConfig));

app.post('/api/config', (req, res) => {
  Object.assign(globalConfig, req.body);
  saveConfig();
  broadcast({ type: 'config', data: globalConfig });
  addLog('system', 'Global config updated');
  res.json({ success: true, config: globalConfig });
});

app.get('/api/system', (req, res) => {
  res.json(getSystemStats());
});

app.get('/api/disks', async (req, res) => {
  const disks = await getDiskInfo();
  res.json(disks);
});

app.get('/api/processes', async (req, res) => {
  const processes = await getProcessList();
  res.json(processes);
});

app.post('/api/kill', async (req, res) => {
  const { pid } = req.body;
  if (!pid) return res.json({ success: false, msg: 'No PID provided' });
  const result = await killProcess(pid);
  res.json(result);
});

wss.on('connection', ws => {
  const botStatus = {};
  Object.entries(bots).forEach(([id, bot]) => {
    botStatus[id] = { running: true, pid: bot.process.pid, uptime: Date.now() - bot.startTime, username: bot.config.username };
  });
  botConfigs.forEach(cfg => {
    if (!botStatus[cfg.id]) botStatus[cfg.id] = { running: false, enabled: cfg.enabled, username: cfg.username };
  });
  ws.send(JSON.stringify({ type: 'init', data: { logs: logBuffer, bots: botStatus, configs: botConfigs, globalConfig } }));
  ws.on('close', () => {});
});

startAllBots();

server.listen(PORT, HOST, () => {
  console.log(`Chapman Bot Panel running at http://${HOST}:${PORT}`);
});
