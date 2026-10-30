const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = 'C:\\ProgramData\\SakuraFrpService';
const DEFAULT_LAUNCHER = 'C:\\Program Files\\SakuraFrpLauncher\\SakuraLauncher.exe';

class SakuraFrpService {
  constructor(options = {}) {
    this.root = options.root || DEFAULT_ROOT;
    this.launcher = options.launcher || DEFAULT_LAUNCHER;
  }

  status(network = {}) {
    const logsDirectory = path.join(this.root, 'Logs');
    const logs = fs.existsSync(logsDirectory)
      ? fs.readdirSync(logsDirectory).filter((name) => /^SakuraFrpService\..+\.log$/i.test(name)).sort().map((name) => path.join(logsDirectory, name))
      : [];
    const tunnels = new Map();
    for (const log of logs.slice(-7)) parseLog(fs.readFileSync(log, 'utf8'), tunnels);
    const rows = [...tunnels.values()];
    const gamePort = Number(network.gameLocalPort) || 25565;
    const voicePort = Number(network.voiceLocalPort) || 24454;
    const game = rows.find((row) => row.protocol === 'tcp' && row.localPort === gamePort && row.running) || rows.find((row) => row.protocol === 'tcp' && row.localPort === gamePort) || null;
    const voice = rows.find((row) => row.protocol === 'udp' && row.localPort === voicePort && row.running) || rows.find((row) => row.protocol === 'udp' && row.localPort === voicePort) || null;
    return {
      installed: fs.existsSync(this.launcher),
      launcherPath: fs.existsSync(this.launcher) ? this.launcher : '',
      serviceConfigured: fs.existsSync(path.join(this.root, 'config.json')),
      running: Boolean(game?.running || voice?.running),
      game,
      voice,
      message: game?.running ? `日志显示游戏隧道已启动：${game.address}；请实际验证连通性` : (game?.address ? `日志显示游戏隧道已关闭；上次地址 ${game.address}` : `未发现匹配本地 TCP ${gamePort} 的隧道日志`)
    };
  }
}

function parseLog(source, tunnels = new Map()) {
  const lines = String(source || '').split(/\r?\n/);
  for (const line of lines) {
    const serviceMatch = /Tunnel\/(\d+)\s+(.+)/.exec(line);
    if (serviceMatch) {
      const tunnel = getTunnel(tunnels, serviceMatch[1]);
      if (/开始加载隧道配置/.test(serviceMatch[2])) tunnel.running = false;
      if (/frpc 已退出|已关闭该隧道/.test(serviceMatch[2])) tunnel.running = false;
    }
    const frpcMatch = /frpc\[(\d+)\|[^\]]+\]\s*(.*)/.exec(line);
    if (!frpcMatch) continue;
    const tunnel = getTunnel(tunnels, frpcMatch[1]);
    const message = frpcMatch[2];
    const local = /隧道本地端口为\s*(\d+)/.exec(message);
    if (local) tunnel.localPort = Number(local[1]);
    const starting = /隧道启动中:\s*\[[^,]+,\s*(tcp|udp)\]/i.exec(message);
    if (starting) tunnel.protocol = starting[1].toLowerCase();
    const address = /使用\s*>>([^<>\s]+)<<\s*连接你的隧道/.exec(message);
    if (address) tunnel.address = address[1];
    if (/隧道启动成功/.test(message)) tunnel.running = true;
  }
  return tunnels;
}

function getTunnel(tunnels, id) {
  if (!tunnels.has(id)) tunnels.set(id, { id, protocol: '', localPort: null, address: '', running: false });
  return tunnels.get(id);
}

module.exports = { SakuraFrpService, parseLog };

