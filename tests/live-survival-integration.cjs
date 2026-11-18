// Opt-in: uses a server copy and a signed-in test profile; never exports its world.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { BotManager } = require('../src/services/bot-manager.cjs');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');
const { SurvivalJobs } = require('../src/services/survival-jobs.cjs');
const { systemScan } = require('../src/services/detector.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value === true) return; if (typeof value === 'string') throw new Error(`${label}: ${value}`); await sleep(500); }
  throw new Error(`${label}超时`);
}
async function main() {
  const profile = process.argv[2]; if (!profile) throw new Error('请提供临时测试配置目录。');
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  config.persona.name = 'MinebotAudit'; config.persona.proactive = false;
  config.network.gameLocalPort = 25575; config.resources.voiceEnabled = false;
  for (const key of Object.keys(config.behavior)) if (typeof config.behavior[key] === 'boolean') config.behavior[key] = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-survival-integration-'));
  const workbuddy = new WorkBuddyService(root);
  const bot = new BotManager(root, workbuddy, { readApiKey: () => '' }, { project: path.join(__dirname, '../runtime/mindcraft-final') });
  const server = new ServerManager(root, { systemScan }); server.exportDailyWorld = async () => ({ path:'test-no-export' });
  server.setLifecycleHooks({ onReady: () => bot.start(config), onStopped: () => bot.stop() });
  const jobs = new SurvivalJobs(root, server, bot);
  try {
    await server.buildAndStart(config);
    await until(() => { const s = server.status(), b = bot.status(); return s.phase === 'failed' ? s.message : b.phase === 'failed' ? b.message : s.ready && b.ready; }, '服务器和伙伴启动');
    const send = command => server.child.stdin.write(`${command}\n`);
    send('difficulty peaceful'); send('forceload add 0 0');
    send('fill 0 99 0 12 99 12 minecraft:stone'); send('fill 0 100 0 12 104 12 minecraft:air');
    send('setblock 6 100 4 minecraft:dirt'); send('setblock 7 100 4 minecraft:dirt');
    send('gamemode survival MinebotAudit'); send('clear MinebotAudit'); send('tp MinebotAudit 2 100 2'); send('effect give MinebotAudit minecraft:instant_health 1 1 true');
    await sleep(3000);
    const p = (x,y,z,name) => ({x,y,z,name});
    const draft = {dimension:'minecraft:overworld', bounds:{min:p(4,100,4),max:p(5,100,4)}, blocks:[p(4,100,4,'dirt'),p(5,100,4,'dirt')], sources:[], harvestAreas:[{min:p(6,100,4),max:p(7,100,4)}]};
    const plan = await jobs.preview(draft);
    if (plan.sources.length !== 2 || plan.scanUnloaded) throw new Error('授权区域采集点扫描失败。');
    const launched = await jobs.start(plan);
    if (!fs.existsSync(path.join(launched.job.backup, 'level.dat'))) throw new Error('施工前世界备份未生成。');
    await until(async () => { const { agent } = await jobs.status(); if (agent.phase === 'blocked' || agent.phase === 'paused') return agent.message; if (agent.phase === 'completed') return '施工过快，无法验证中途暂停。'; return agent.completed >= 1; }, '等待第一块完成', 90000);
    await jobs.stop();
    await until(async () => { const { agent } = await jobs.status(); return agent.phase === 'paused'; }, '暂停伙伴施工', 30000);
    await server.stopAndWait();
    await until(() => !bot.status().running, '伙伴退出', 30000);
    await server.buildAndStart(config);
    await until(() => { const s = server.status(), b = bot.status(); return s.phase === 'failed' ? s.message : b.phase === 'failed' ? b.message : s.ready && b.ready; }, '重启服务器和伙伴');
    await sleep(2000);
    const resumed = await jobs.resume();
    if (resumed.job.backup === launched.job.backup || !fs.existsSync(path.join(resumed.job.backup, 'level.dat'))) throw new Error('继续施工前的备份未生成。');
    await until(async () => { const { agent } = await jobs.status(); if (agent.phase === 'blocked' || agent.phase === 'paused') return agent.message; return agent.phase === 'completed' && agent.completed === 2; }, '生存施工', 120000);
    console.log('单伙伴桥接、施工前备份、计划保存、采集、重启后恢复及逐块施工通过；未导出测试世界。');
  } finally { await bot.stop().catch(() => {}); await server.stopAndWait().catch(() => {}); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
