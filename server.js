const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// Инициализация клиента Supabase через переменные окружения Render
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

const CONFIG_FILE = path.join(__dirname, 'config.json');

let bots = {};
let logBuffer = [];
const MAX_LOGS = 2000;

let globalConfig = {
    host: 'ghjghjghjghjdfg-M3DJ.aternos.me',
    port: 41441,
    version: '1.21.11',
    username: 'bot',
    auth: 'offline',
    password: 'botpassword',
    autoReconnect: true,
    antiAfk: true
};

let botConfigs = [];

async function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            globalConfig = { ...globalConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) };
        }
    } catch (e) {
        console.error('Config load error:', e);
    }

    if (supabase) {
        try {
            const { data, error } = await supabase.from('bot').select('*');
            if (error) {
                console.error('Supabase load error:', error.message);
            } else if (data && data.length > 0) {
                botConfigs = data;
                console.log(`Loaded ${botConfigs.length} bots from Supabase.`);
            } else {
                // Создаем дефолтного бота, если таблица пуста
                const defaultBot = {
                    id: 'bot_' + Date.now(),
                    username: 'bot',
                    host: globalConfig.host,
                    port: globalConfig.port,
                    version: globalConfig.version,
                    auth: globalConfig.auth,
                    password: globalConfig.password,
                    autoReconnect: globalConfig.autoReconnect,
                    antiAfk: globalConfig.antiAfk,
                    enabled: true
                };
                const { error: insertError } = await supabase.from('bot').insert([defaultBot]);
                if (insertError) {
                    console.error('Supabase default bot insert error:', insertError.message);
                } else {
                    botConfigs = [defaultBot];
                    console.log('Created default bot in Supabase.');
                }
            }
        } catch (e) {
            console.error('Supabase connection error during load:', e.message);
        }
    } else {
        console.warn('WARNING: Supabase credentials are not set!');
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(globalConfig, null, 2));
    } catch (e) {
        console.error('Config save error:', e.message);
    }
}

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

async function stopBot(botId) {
    const bot = bots[botId];
    const cfg = botConfigs.find(b => b.id === botId);
    if (cfg) {
        cfg.autoReconnect = false;
        if (supabase) {
            await supabase.from('bot').update({ autoReconnect: false }).eq('id', botId);
        }
    }
    if (!bot) return { success: false, msg: 'Bot not running' };
    bot.process.kill('SIGTERM');
    addLog('system', `Stopping bot ${bot.config.username}...`, botId);
    return { success: true };
}

async function restartBot(botId) {
    await stopBot(botId);
    setTimeout(async () => {
        const cfg = botConfigs.find(b => b.id === botId);
        if (cfg) {
            cfg.autoReconnect = true;
            if (supabase) {
                await supabase.from('bot').update({ autoReconnect: true }).eq('id', botId);
            }
            startBot(cfg);
        }
    }, 1000);
    return { success: true };
}

function startAllBots() {
    botConfigs.filter(b => b.enabled).forEach(startBot);
}

async function stopAllBots() {
    for (const botId of Object.keys(bots)) {
        await stopBot(botId);
    }
}

function getProcessList() {
    return new Promise((resolve) => {
        const platform = os.platform();
        let cmd = platform === 'win32' ? 'tasklist /FO CSV /NH' : 'ps aux --sort=-%cpu';
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(getProcessListFallback());
            const processes = [];
            if (platform === 'win32') {
                stdout.trim().split('\n').slice(0, 80).forEach(line => {
                    const match = line.match(/"([^"]*)","(\d+)"/);
                    if (match) processes.push({ pid: parseInt(match[2]), name: match[1], cmd: '', mem: 0, cpu: 0 });
                });
            } else {
                stdout.trim().split('\n').slice(1).slice(0, 40).forEach(line => {
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
    if (cpus && cpus.length > 0) {
        cpus.forEach(cpu => {
            for (const type in cpu.times) totalTick += cpu.times[type];
            totalIdle += cpu.times.idle;
        });
    }
    const cpuUsage = totalTick > 0 ? (100 - (totalIdle / totalTick * 100)) : 0;
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;

    return {
        cpu: { usage: cpuUsage.toFixed(1), cores: cpus ? cpus.length : 1, model: cpus && cpus[0] ? cpus[0].model : 'Unknown', load: os.loadavg() },
        memory: { total: memTotal, used: memUsed, free: memFree, usagePercent: memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(1) : 0 },
        uptime: os.uptime(),
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

app.post('/api/start', async (req, res) => {
    const { id } = req.body;
    if (id) {
        const cfg = botConfigs.find(b => b.id === id);
        res.json(cfg ? startBot(cfg) : { success: false, msg: 'Bot not found' });
    } else {
        startAllBots();
        res.json({ success: true });
    }
});

app.post('/api/stop', async (req, res) => {
    const { id } = req.body;
    if (id) res.json(await stopBot(id));
    else { await stopAllBots(); res.json({ success: true }); }
});

app.post('/api/restart', async (req, res) => {
    const { id } = req.body;
    if (id) res.json(await restartBot(id));
    else { await stopAllBots(); setTimeout(startAllBots, 1000); res.json({ success: true }); }
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

app.get('/api/processes', (req, res) => {
    const result = botConfigs.map(cfg => {
        const runningBot = bots[cfg.id];
        return {
            id: cfg.id,
            name: cfg.username,
            status: runningBot ? 'online' : 'offline',
            pid: runningBot ? runningBot.process.pid : null,
            host: cfg.host,
            port: cfg.port
        };
    });
    res.json(result);
});

app.get('/api/bots', (req, res) => {
    res.json(botConfigs);
});

app.post('/api/bots', async (req, res) => {
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
    
    if (supabase) {
        const { error } = await supabase.from('bot').insert([newBot]);
        if (error) console.error('Supabase insert error:', error.message);
    }

    broadcast({ type: 'botsUpdated', data: botConfigs });
    addLog('system', `Added bot: ${username}`);
    res.json({ success: true, bot: newBot });
});

app.put('/api/bots/:id', async (req, res) => {
    const { id } = req.params;
    const idx = botConfigs.findIndex(b => b.id === id);
    if (idx === -1) return res.json({ success: false, msg: 'Bot not found' });
    const updates = req.body;
    delete updates.id;
    
    botConfigs[idx] = { ...botConfigs[idx], ...updates };

    if (supabase) {
        const { error } = await supabase.from('bot').update(updates).eq('id', id);
        if (error) console.error('Supabase update error:', error.message);
    }

    broadcast({ type: 'botsUpdated', data: botConfigs });
    if (bots[id] && (updates.host || updates.port || updates.version || updates.username || updates.password || updates.auth)) {
        addLog('system', `Config changed for ${botConfigs[idx].username}, restart to apply`, id);
    }
    res.json({ success: true, bot: botConfigs[idx] });
});

app.delete('/api/bots/:id', async (req, res) => {
    const { id } = req.params;
    await stopBot(id);
    botConfigs = botConfigs.filter(b => b.id !== id);

    if (supabase) {
        const { error } = await supabase.from('bot').delete().eq('id', id);
        if (error) console.error('Supabase delete error:', error.message);
    }

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

app.get('/api/system', (req, res) => res.json(getSystemStats()));

app.get('/api/disks', async (req, res) => {
    const disks = await getDiskInfo();
    res.json(disks);
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
    ws.send(JSON.stringify({ type: 'init', data: { logs: logBuffer, bots: botStatus, configs: botConfigs, config: globalConfig } }));
    ws.on('close', () => {});
});

// Запускаем сервер только после загрузки конфигурации из базы данных
loadConfig().then(() => {
    server.listen(PORT, HOST, () => {
        console.log(`Chapman Bot Panel running at http://${HOST}:${PORT}`);
    });
});
