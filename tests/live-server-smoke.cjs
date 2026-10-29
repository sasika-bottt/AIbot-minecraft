const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { systemScan } = require('../src/services/detector.cjs');

const profile = process.argv[2] || path.join(process.env.APPDATA || '', 'jingban-desktop', 'profile');
const configPath = path.join(profile, 'config.json');
const timeoutMs = Number(process.env.JINGBAN_LIVE_TEST_TIMEOUT || 300000);

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function main() {
  if (!fs.existsSync(configPath)) throw new Error(`配置不存在：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const manager = new ServerManager(profile, { systemScan });
  let reachedReady = false;
  let portReachable = false;
  let lastPhase = '';
  manager.exportDailyWorld = async () => ({ path: 'live-smoke-no-export' });
  manager.setLifecycleHooks({
    onReady: async () => {
      reachedReady = true;
      portReachable = await canConnect(Number(config.network.gameLocalPort) || 25565);
      console.log(`LIVE_READY port=${portReachable ? 'reachable' : 'unreachable'} excluded=${manager.status().excludedMods.length}`);
      manager.stop();
    }
  });
  await manager.buildAndStart(config);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = manager.status();
    if (status.phase !== lastPhase) {
      lastPhase = status.phase;
      console.log(`PHASE ${status.phase}: ${status.message}`);
    }
    if (status.phase === 'failed') throw new Error(`${status.message} 日志：${status.logPath}`);
    if (reachedReady && status.phase === 'stopped') {
      if (!portReachable) throw new Error('Forge 报告就绪，但 25565 无法连接。');
      console.log(`LIVE_PASS build=${status.serverDirectory}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  manager.stop();
  throw new Error(`等待服务器就绪超时（${timeoutMs}ms）。`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
