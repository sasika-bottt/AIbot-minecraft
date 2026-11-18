// Visual-review fixture: isolated example data only; never reads the user's profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/services/config-store.cjs');

app.disableHardwareAcceleration();
const outputDir = path.join(__dirname, '../docs/assets');
const config = structuredClone(DEFAULT_CONFIG);
config.persona.name = '示例伙伴';
config.game.instanceName = '示例整合包';
config.network.gameAddress = 'play.example.invalid:25565';

const planner = {
  mode: 'manual',
  updatedAt: new Date().toISOString(),
  messages: [
    { role: 'user', content: '我想在村庄北边建一座带阁楼的小旅馆，不要破坏农田。' },
    { role: 'assistant', content: '可以。我会先确认施工范围、入口朝向和可用材料，再生成逐块预览。施工前会备份世界，不会直接拆除已有方块。' }
  ]
};

const handlers = {
  'app:get-state': () => ({ config, version: require('../package.json').version }),
  'app:save-config': (_, value) => value.config,
  'system:scan': () => ({ java: [{ path: 'C:\\Program Files\\Java\\bin\\java.exe', major: 21 }], instances: [] }),
  'voice:list': () => [],
  'workbuddy:status': () => ({ signedIn: true, available: true, nickname: '示例用户' }),
  'workbuddy:models': () => [{ id: 'economy-demo', name: '经济模型', credits: '按积分结算', contextWindow: 32000 }],
  'server:status': () => ({ phase: 'idle', ready: false, message: '等待准备' }),
  'bot:status': () => ({ phase: 'idle', ready: false }),
  'network:sakura-status': () => ({ installed: false, game: {}, voice: {} }),
  'app:self-check': () => ({ ready: false, pending: true, blockingFailures: 1, items: [] }),
  'skin:read': () => '',
  'shell:open-path': () => '',
  'build:get-state': () => planner,
  'build:set-mode': (_, mode) => ({ ...planner, mode }),
  'build:survival-status': () => ({ job: null, agent: { phase: 'idle', message: '尚无施工任务。' } }),
  'build:clear': () => ({ ...planner, messages: [] })
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

async function settle(win) {
  await new Promise(resolve => setTimeout(resolve, 350));
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function capture(win, fileName) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, fileName), image.toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const main = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true }
  });
  await main.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await settle(main);
  await main.webContents.executeJavaScript(`state.wbStatus={signedIn:true,available:true,nickname:'示例用户'};state.wbModels=[{id:'economy-demo',name:'经济模型',credits:'按积分结算',contextWindow:32000}];state.config.model.workbuddyModel='economy-demo';state.step=0;render()`);
  await settle(main);
  await capture(main, 'minebot-ui-1.0.8-components.png');

  await main.webContents.executeJavaScript(`state.step=5;state.selfCheck={ready:false,pending:true,blockingFailures:1,checks:[
    {id:'model',title:'AI 模型',detail:'WorkBuddy 积分通道已连接',status:'pass',ok:true,blocking:true},
    {id:'runtime',title:'服务端运行环境',detail:'缺少的运行资源可由 Minebot 自动准备',status:'pending',blocking:true},
    {id:'mods',title:'模组兼容性',detail:'一个内容模组可能影响世界，请先查看影响',status:'choice',needsChoice:true,blocking:true},
    {id:'world',title:'世界存档',detail:'已创建独立服务器副本',status:'pass',ok:true,blocking:true},
    {id:'network',title:'联机设置',detail:'公网地址可在开服后配置',status:'optional',blocking:false}
  ]};render()`);
  await settle(main);
  await capture(main, 'minebot-ui-1.0.8-self-check.png');

  const butler = new BrowserWindow({
    width: 1080,
    height: 820,
    show: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true }
  });
  await butler.loadFile(path.join(__dirname, '../src/renderer/build-chat.html'));
  await settle(butler);
  await butler.webContents.executeJavaScript(`setComposerActivity({active:true,label:'正在整理建造需求与施工边界'})`);
  await settle(butler);
  await capture(butler, 'minebot-ui-1.0.8-butler-components.png');
  butler.destroy();
  main.destroy();
  console.log('component preview screenshots generated');
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
