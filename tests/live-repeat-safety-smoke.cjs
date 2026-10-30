// Explicit opt-in only: uses a copy of the supplied world and a real WorkBuddy account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { BotManager } = require('../src/services/bot-manager.cjs');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');
const { systemScan } = require('../src/services/detector.cjs');

const profile = process.argv[2];
if (!profile) throw new Error('请显式提供临时测试配置目录。');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result === true) return;
    if (typeof result === 'string') throw new Error(`${label}: ${result}`);
    await sleep(500);
  }
  throw new Error(`${label}超时`);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  config.persona.name = 'MinebotAudit';
  config.network.gameLocalPort = 25575;
  config.resources.voiceEnabled = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-repeat-test-'));
  const workbuddy = new WorkBuddyService(root);
  const bot = new BotManager(root, workbuddy, { readApiKey: () => '' }, { project: process.env.JINGBAN_TEST_BOT_PROJECT });
  const server = new ServerManager(root, { systemScan });
  server.exportDailyWorld = async () => ({ path: 'test-no-export' });
  server.setLifecycleHooks({ onReady: () => bot.start(config), onStopped: () => bot.stop() });
  try {
    for (let n = 0; n < 2; n++) {
      await server.buildAndStart(config);
      await waitFor(() => {
        const s = server.status(), b = bot.status();
        if (s.phase === 'failed') return s.message;
        if (b.phase === 'failed') return b.message;
        return s.ready && b.ready;
      }, `第 ${n + 1} 次启动`);
      const dir = server.status().serverDirectory;
      const marker = path.join(dir, 'world', 'minebot-audit-marker.txt');
      if (n === 0) {
        const construction = await server.executeAdminCommands(['/setblock 0 100 0 minecraft:stone']);
        if (!fs.existsSync(path.join(construction.backupPath, 'level.dat'))) throw new Error('施工备份未生成');
        await waitFor(() => /Changed the block at|Set block at/i.test(server.recentOutput), '施工命令结果', 15000);
        fs.writeFileSync(marker, 'persisted');
        console.log('模拟世界中的施工备份与单方块命令已由服务器确认');
      }
      else if (fs.readFileSync(marker, 'utf8') !== 'persisted') throw new Error('第二次启动未接续测试世界进度');
      server.stop();
      await waitFor(() => {
        const s = server.status();
        if (s.phase === 'failed') return s.message;
        return s.phase === 'stopped' && !bot.status().running;
      }, `第 ${n + 1} 次停服`);
      console.log(`第 ${n + 1} 次启动、伙伴加入和安全停服通过`);
    }
    console.log('重复开服的世界延续实测通过；没有导出到用户存档。');
  } finally {
    await bot.stop().catch(() => {});
    server.stop();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

