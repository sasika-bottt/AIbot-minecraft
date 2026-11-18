const fs = require('node:fs');
const path = require('node:path');
const { BotManager } = require('../src/services/bot-manager.cjs');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');

const profile = process.argv[2] || path.join(process.env.APPDATA || '', 'jingban-desktop', 'profile');
const configPath = path.join(profile, 'config.json');
const project = path.join(__dirname, '..', 'runtime', 'mindcraft-final');
const timeoutMs = Number(process.env.JINGBAN_BOT_TEST_TIMEOUT || 90000);

async function main() {
  if (!fs.existsSync(configPath)) throw new Error(`配置不存在：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const workbuddy = new WorkBuddyService(profile);
  const manager = new BotManager(profile, workbuddy, { readApiKey: () => '' }, { project });
  let lastPhase = '';
  await manager.start(config);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = manager.status();
    if (status.phase !== lastPhase) {
      lastPhase = status.phase;
      console.log(`PHASE ${status.phase}: ${status.message}`);
    }
    if (status.ready) {
      console.log(`BOT_READY name=${status.name} pid=${status.pid}`);
      await manager.stop();
      while (manager.status().running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      console.log(`BOT_PASS log=${status.logPath}`);
      return;
    }
    if (status.phase === 'failed') throw new Error(`${status.message} 日志：${status.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await manager.stop();
  throw new Error(`等待 AI 伙伴进入游戏超时（${timeoutMs}ms）。日志：${manager.status().logPath}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
