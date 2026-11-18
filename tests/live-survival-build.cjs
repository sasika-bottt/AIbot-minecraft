// Opt-in: creates a disposable server copy. Never exports back to a user world.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { systemScan } = require('../src/services/detector.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value === true) return; if (typeof value === 'string') throw new Error(`${label}: ${value}`); await sleep(500); }
  throw new Error(`${label}超时`);
}
async function main() {
  const profile = process.argv[2];
  if (!profile) throw new Error('需要显式指定测试配置目录。');
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  config.network.gameLocalPort = 25575; config.resources.voiceEnabled = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-survival-test-'));
  const server = new ServerManager(root, { systemScan });
  server.exportDailyWorld = async () => ({ path: 'test-no-export' });
  let agent;
  try {
    await server.buildAndStart(config);
    await until(() => server.status().phase === 'failed' ? server.status().message : server.status().ready, '服务器启动');
    const send = command => server.child.stdin.write(`${command}\n`);
    send('difficulty peaceful');
    send('forceload add 0 0');
    send('fill 0 99 0 12 99 12 minecraft:stone');
    send('fill 0 100 0 12 104 12 minecraft:air');
    send('setblock 6 100 4 minecraft:dirt');
    send('setblock 7 100 4 minecraft:dirt');
    send('setblock 9 100 4 minecraft:oak_log');
    send('setblock 8 100 6 minecraft:chest');
    send('setblock 11 100 4 minecraft:dirt');
    await sleep(3000);
    agent = spawn(process.execPath, [path.join(__dirname, 'live-survival-agent.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    agent.stdout.on('data', data => { output += data; });
    agent.stderr.on('data', data => { output += data; });
    await until(() => output.includes('MINEBOT_TEST_SPAWNED') ? true : agent.exitCode !== null ? output.slice(-1200) : false, '伙伴进入');
    send('gamemode survival MinebotBuildTest');
    send('clear MinebotBuildTest');
    send('tp MinebotBuildTest 2 100 2');
    send('effect give MinebotBuildTest minecraft:instant_health 1 1 true');
    await sleep(2000);
    agent.stdin.write('go\n');
    await until(() => output.includes('MINEBOT_TEST_COMPLETED') ? true : output.includes('MINEBOT_TEST_FAILED') || agent.exitCode !== null ? output.slice(-1500) : false, '采集与施工', 90000);
    console.log('隔离服务器中的采集、暂停接续和两种材料生存施工通过；未导出测试世界。');
  } finally {
    if (agent && agent.exitCode === null) agent.kill();
    await server.stopAndWait().catch(() => {});
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
