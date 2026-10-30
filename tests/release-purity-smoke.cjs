const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingban-fresh-'));
try {
  const resources = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources');
  const archive = path.join(resources, 'app.asar');
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(manifest.name, 'minebot-desktop');
  const build = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build;
  assert.equal(build.productName, 'minebot');
  assert.equal(build.appId, 'cn.minebot.companion');
  const mainSource = asar.extractFile(archive, 'src\\main.cjs').toString('utf8');
  assert.ok(!mainSource.includes('migrateLegacyProfile'), '首次启动不得自动导入旧配置');
  const packedConfigPath = path.join(root, 'packaged-config-store.cjs');
  fs.writeFileSync(packedConfigPath, asar.extractFile(archive, 'src\\services\\config-store.cjs'));
  const { ConfigStore } = require(packedConfigPath);
  const config = new ConfigStore(root, {}).load();
  assert.equal(config.model.workbuddyModel, '');
  assert.equal(config.model.hasApiKey, false);
  for (const key of ['instancePath', 'worldPath', 'archivePath', 'minecraftVersion', 'modLoader']) assert.equal(config.game[key], '');
  for (const key of ['name', 'description', 'skinPath', 'builtinSkin']) assert.equal(config.persona[key], '');
  assert.deepEqual(config.server.administrators, []);
  assert.equal(config.server.templatePath, '');
  assert.equal(config.network.gameAddress, '');
  assert.equal(config.network.voiceAddress, '');
  assert.equal(config.resources.voiceEnabled, false);

  const packedPaths = asar.listPackage(archive);
  assert.ok(!packedPaths.some((entry) => /whale-skin\.png$/i.test(entry)), '不得打包个人伙伴皮肤');
  const appSources = packedPaths.filter((entry) => /\.(cjs|js|html|json)$/i.test(entry) && /^\\src\\/i.test(entry));
  for (const relative of ['src\\main.cjs', 'src\\preload.cjs', 'src\\services\\config-store.cjs', 'src\\services\\detector.cjs', 'src\\services\\bot-manager.cjs', 'src\\services\\server-manager.cjs', 'src\\services\\build-planner.cjs', 'src\\services\\skin-export.cjs', 'src\\services\\survival-jobs.cjs', 'src\\renderer\\app.js', 'src\\renderer\\build-chat.js', 'src\\renderer\\build-chat.html']) {
    assert.deepEqual(asar.extractFile(archive, relative), fs.readFileSync(path.join(__dirname, '..', relative)), `打包源码不是最新版本：${relative}`);
  }
  const forbidden = ['EXAMPLE_PERSONAL_MARKER'];
  for (const entry of appSources) {
    const content = asar.extractFile(archive, entry.slice(1)).toString('utf8');
    for (const value of forbidden) assert.ok(!content.includes(value), `安装包中发现个人测试标识: ${entry}`);
  }
  const botDir = path.join(resources, 'runtime', 'mindcraft', 'bots');
  for (const relative of ['src/agent/npc/survival_build.js', 'src/agent/npc/survival_adapter.js', 'src/agent/npc/survival_controller.js', 'src/agent/mindserver_proxy.js', 'src/mindcraft/mindserver.js', 'src/utils/mcdata.js']) {
    assert.deepEqual(fs.readFileSync(path.join(resources, 'runtime', 'mindcraft', relative)), fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mindcraft-final', relative)), `伙伴运行代码不是最新版本：${relative}`);
  }
  assert.deepEqual(fs.readdirSync(botDir).sort(), ['execTemplate.js', 'lintTemplate.js']);
  const profile = JSON.parse(fs.readFileSync(path.join(resources, 'runtime', 'mindcraft', 'wb.json'), 'utf8'));
  assert.equal(profile.name, '');
  const runtimeSettings = fs.readFileSync(path.join(resources, 'runtime', 'mindcraft', 'settings.js'), 'utf8');
  assert.match(runtimeSettings, /"minecraft_version":\s*"auto"/);
  assert.match(runtimeSettings, /"forge_server":\s*false/);
  const serverTemplate = path.join(resources, 'runtime', 'server-template');
  assert.equal(fs.existsSync(serverTemplate), false, '发布包不应包含游戏服务端文件');
  assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js')), '积分通道组件应随安装包提供');
  assert.ok(fs.existsSync(path.join(resources, 'runtime', 'node.exe')), '伙伴运行时应随安装包提供');
  assert.ok(fs.existsSync(path.join(resources, 'runtime', 'mindcraft', 'node_modules', 'mineflayer')), '伙伴依赖应随安装包提供');
  console.log('release purity smoke test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
