// Render the actual renderer/preload with isolated IPC fixtures, never a user profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../src/services/config-store.cjs');
const config = structuredClone(DEFAULT_CONFIG);
config.persona.name = 'DemoBot';
config.network.gameAddress = 'example.invalid:25565';
let status = { phase: 'failed', ready: false, message: '示例模组需要选择兼容版本', errorCode: 'MOD_CHOICE_REQUIRED', history: [{ message: '运行环境已准备好' }, { message: '原世界已保留，等待选择兼容模组' }] };
for (const [channel, handler] of Object.entries({
  'app:get-state': () => ({ config, version: require('../package.json').version }), 'app:save-config': (_, value) => value.config,
  'system:scan': () => ({ java: [], instances: [] }), 'voice:list': () => [],
  'workbuddy:status': () => { throw new Error('simulated unavailable account service'); }, 'server:status': () => status,
  'bot:status': () => ({ phase: 'idle' }), 'network:sakura-status': () => ({ game: {}, voice: {} }),
  'skin:read': () => '', 'server:prepare': () => ({ ...status, phase: 'idle', resolvedGame: config.game }),
  'app:self-check': () => ({ items: [] }), 'shell:open-path': () => ''
})) ipcMain.handle(channel, handler);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1220, height: 900, show: false, webPreferences: { offscreen: true, preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (_, details) => { if (details.level === 'error') console.error(details.message); });
  win.webContents.on('preload-error', (_, __, error) => errors.push(error.message));
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await new Promise(resolve => setTimeout(resolve, 700));
  await win.webContents.executeJavaScript('state.step=6;render()');
  const result = await win.webContents.executeJavaScript("({text:document.body.textContent,choice:!!document.getElementById('open-source-mods'),overflow:document.documentElement.scrollWidth>innerWidth})");
  assert.equal(result.choice, true); assert.equal(result.overflow, false);
  assert.ok(result.text.includes(require('../package.json').version));
  assert.match(result.text, /方块或物品消失/); assert.match(result.text, /等待游戏服务器就绪/);
  fs.writeFileSync(path.join(process.env.TEMP, 'minebot-105-dashboard.png'), (await win.webContents.capturePage()).toPNG());
  status = { ...status, errorCode: 'WORLD_CHOICE_REQUIRED', recovery: { backupPath: 'C:\\example-backup', needsChoice: true } };
  await win.webContents.executeJavaScript('(async()=>{state.serverStatus=await window.whale.serverStatus();render()})()');
  assert.equal(await win.webContents.executeJavaScript("!!document.getElementById('choose-another-world')"), true);
  await win.webContents.executeJavaScript("applyInstance('unknown-pack',{});state.step=1;render()");
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('loader').value"), '', '未知整合包不能默认变成 Forge');
  assert.deepEqual(errors, []);
  console.log('Electron dashboard, conflict choice and recovery UI tests passed');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
