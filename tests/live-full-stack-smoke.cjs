const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { BotManager } = require('../src/services/bot-manager.cjs');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');
const { systemScan } = require('../src/services/detector.cjs');

const profile = process.argv[2] || path.join(process.env.APPDATA || '', 'jingban-desktop', 'profile');
const timeoutMs = Number(process.env.JINGBAN_FULL_TEST_TIMEOUT || 180000);

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
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  config.persona.name = 'MiXeDTest';
  config.network.gameLocalPort = 25575;
  config.network.voiceLocalPort = 24455;
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jingban-full-stack-'));
  const workbuddy = new WorkBuddyService(testRoot);
  const bot = new BotManager(testRoot, workbuddy, { readApiKey: () => '' }, { project: process.env.JINGBAN_TEST_BOT_PROJECT || path.join(__dirname, '..', 'runtime', 'mindcraft-final') });
  const server = new ServerManager(testRoot, { systemScan });
  server.exportDailyWorld = async () => ({ path: 'live-full-stack-no-export' });
  server.setLifecycleHooks({ onReady: () => bot.start(config), onStopped: () => bot.stop() });
  let lastServerPhase = '';
  let lastBotPhase = '';
  let passed = false;
  try {
    await server.buildAndStart(config);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const serverStatus = server.status();
      const botStatus = bot.status();
      if (serverStatus.phase !== lastServerPhase) {
        lastServerPhase = serverStatus.phase;
        console.log(`SERVER ${serverStatus.phase}: ${serverStatus.message}`);
      }
      if (botStatus.phase !== lastBotPhase) {
        lastBotPhase = botStatus.phase;
        console.log(`BOT ${botStatus.phase}: ${botStatus.message}`);
      }
      if (serverStatus.phase === 'failed') throw new Error(`服务器失败：${serverStatus.message} 日志：${serverStatus.logPath}`);
      if (botStatus.phase === 'failed') throw new Error(`伙伴失败：${botStatus.message} 日志：${botStatus.logPath}`);
      if (serverStatus.ready && botStatus.ready) {
        if (!await canConnect(config.network.gameLocalPort)) throw new Error('服务器报告就绪，但测试端口不可连接。');
        await require('node:assert/strict').rejects(server.setAdministrator('MiXeDMissing', true), /尚未确认玩家/);
        const opsFile = path.join(serverStatus.serverDirectory, 'ops.json');
        const ops = fs.existsSync(opsFile) ? JSON.parse(fs.readFileSync(opsFile, 'utf8')) : [];
        if (ops.some((entry) => entry.name.toLowerCase() === 'mixedmissing')) throw new Error('未加入的玩家不得产生错误大小写管理员');
        console.log('MIXED_CASE_UNVERIFIED_REJECTED');
        await server.setAdministrator(config.persona.name, true);
        await server.setAdministrator(config.persona.name, false);
        console.log('ADMIN_GRANT_REVOKE_PASS');
        passed = true;
        console.log(`FULL_STACK_READY server=${serverStatus.serverDirectory} bot=${botStatus.name}`);
        await bot.stop();
        server.stop();
      }
      if (passed && !server.status().running && !bot.status().running) {
        console.log('FULL_STACK_PASS');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`全链路测试超时（${timeoutMs}ms）。`);
  } finally {
    await bot.stop().catch(() => {});
    server.stop();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
