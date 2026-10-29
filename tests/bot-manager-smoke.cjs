const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BotManager, findNodeExecutable } = require('../src/services/bot-manager.cjs');

async function waitFor(test, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待伙伴状态超时');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockmate-bot-'));
  const project = path.join(root, 'mindcraft');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(project, 'bots'), { recursive: true });
  fs.writeFileSync(path.join(project, 'wb.json'), JSON.stringify({ name: 'old', model: 'workbuddy/old', modes: {} }));
  fs.writeFileSync(path.join(project, 'main.js'), "require('node:fs').writeFileSync('cwd-marker.txt', process.cwd()); require('node:fs').writeFileSync('settings-marker.json', process.env.SETTINGS_JSON); console.log('fake spawned.'); setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));\n");
  fs.writeFileSync(path.join(project, 'bots', 'lintTemplate.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(project, 'bots', 'execTemplate.js'), 'module.exports = {};\n');
  let gatewayStarted = 0;
  let gatewayStopped = 0;
  const workbuddy = {
    async startGateway() { gatewayStarted += 1; return { baseUrl: 'http://127.0.0.1:12345', token: 'test-token' }; },
    async stopGateway() { gatewayStopped += 1; }
  };
  const configStore = { readApiKey: () => 'test-key' };
  const manager = new BotManager(path.join(root, 'profile'), workbuddy, configStore, { project, supportsVersion: () => true });
  try {
    assert.ok(findNodeExecutable(), '应找到应用内置或本机可用的 Node.js');
    await manager.start({
      model: { channel: 'workbuddy', workbuddyModel: 'deepseek-v4.1-flash' },
      persona: { name: 'test_buddy', proactive: true },
      behavior: { selfPreservation: true, unstuck: true, selfDefense: true, itemCollecting: true, torchPlacing: true, idleStaring: true },
      network: { gameLocalPort: 25565 },
      game: { minecraftVersion: '1.20.1', modLoader: 'forge' },
      resources: { voiceEnabled: false, ttsVoice: 'Test Voice' }
    });
    await waitFor(() => manager.status().ready);
    assert.equal(manager.status().name, 'test_buddy');
    assert.equal(gatewayStarted, 1);
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'bot-runtime', 'active-profile.json'), 'utf8'));
    assert.equal(profile.model, 'workbuddy/deepseek-v4.1-flash');
    assert.equal(profile.modes.item_collecting, true);
    const runtimeDirectory = path.join(root, 'profile', 'bot-runtime');
    assert.equal(fs.readFileSync(path.join(runtimeDirectory, 'cwd-marker.txt'), 'utf8'), runtimeDirectory, '伙伴必须从用户可写的运行目录启动');
    assert.equal(fs.existsSync(path.join(project, 'cwd-marker.txt')), false, '不得向安装目录写入伙伴运行文件');
    const settings = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'settings-marker.json'), 'utf8'));
    assert.equal(settings.minecraft_version, '1.20.1');
    assert.equal(settings.forge_server, true);
    assert.equal(settings.voice_enabled, false);
    assert.equal(settings.voice_name, 'Test Voice');
    await manager.stop();
    await waitFor(() => !manager.status().running);
    assert.equal(gatewayStopped, 1);
    console.log('bot manager lifecycle smoke test passed');
  } finally {
    if (manager.status().running) await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
