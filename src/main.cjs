const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeImage } = require('electron');
const { ConfigStore } = require('./services/config-store.cjs');
const { WorkBuddyService } = require('./services/workbuddy.cjs');
const { BuildPlanner } = require('./services/build-planner.cjs');
const { ServerManager, resolveTemplate, findWinArgs, assessRuntimeCompatibility, selectJavaRuntime, isPortAvailable } = require('./services/server-manager.cjs');
const { BotManager, findNodeExecutable, findBundledProject, inspectBotRuntime, botSupportsMinecraftVersion } = require('./services/bot-manager.cjs');
const { SakuraFrpService } = require('./services/sakura-frp.cjs');
const { systemScan, inspectInstance } = require('./services/detector.cjs');
const { ArchiveManager } = require('./services/archive-manager.cjs');
const { listSystemVoices, previewSystemVoice, hasChineseRecognizer } = require('./services/system-voices.cjs');
const { validateSkin, exportSkin } = require('./services/skin-export.cjs');

let mainWindow;
let configStore;
let workbuddy;
let buildPlanner;
let buildWindow;
let serverManager;
let botManager;
let sakuraFrp;
let archiveManager;
let quitAllowed = false;
let shutdownInProgress = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#eef2f4',
    icon: path.join(__dirname, 'renderer', 'assets', 'jingban-icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#eef2f4', symbolColor: '#334155', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: Boolean(process.env.WHALE_SCREENSHOT)
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    const active = serverManager?.status().running || botManager?.status().running;
    if (!quitAllowed && active) {
      event.preventDefault();
      requestSafeQuit().catch((error) => dialog.showErrorBox('无法安全退出', error.message || String(error)));
    }
  });
  if (process.env.WHALE_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage({ x: 0, y: 0, width: 1220, height: 820 });
          const png = image.toPNG();
          if (!png.length) throw new Error('预览截图为空');
          fs.writeFileSync(process.env.WHALE_SCREENSHOT, png);
        } catch (error) {
          console.error(error.message);
        } finally {
          app.quit();
        }
      }, 4200);
    });
  }
}

async function requestSafeQuit() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  try {
    const serverRunning = serverManager?.status().running;
    const botRunning = botManager?.status().running;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['先安全保存再退出', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: 'minebot仍在运行',
      message: serverRunning ? '服务器仍在运行，直接关闭可能损坏世界存档。' : 'AI 伙伴仍在运行。',
      detail: botRunning ? 'minebot将先让伙伴退出，再通知服务器保存世界。' : 'minebot将通知服务器保存世界后再退出。'
    });
    if (result.response !== 0) return;
    if (botRunning) await botManager.stop();
    if (serverRunning) await serverManager.stopAndWait();
    quitAllowed = true;
    app.quit();
  } finally {
    shutdownInProgress = false;
  }
}

function openBuildWindow() {
  if (buildWindow && !buildWindow.isDestroyed()) {
    buildWindow.show();
    buildWindow.focus();
    return;
  }
  buildWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 720,
    minHeight: 600,
    parent: mainWindow,
    modal: false,
    backgroundColor: '#eef2f4',
    icon: path.join(__dirname, 'renderer', 'assets', 'jingban-icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#eef2f4', symbolColor: '#334155', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  buildWindow.loadFile(path.join(__dirname, 'renderer', 'build-chat.html'));
  buildWindow.on('closed', () => { buildWindow = null; });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  configStore = new ConfigStore(userDataPath, safeStorage);
  workbuddy = new WorkBuddyService(configStore.publicPaths().dataDirectory);
  botManager = new BotManager(configStore.publicPaths().dataDirectory, workbuddy, configStore);
  sakuraFrp = new SakuraFrpService();
  archiveManager = new ArchiveManager(configStore.publicPaths().dataDirectory, inspectInstance);
  buildPlanner = new BuildPlanner(configStore.publicPaths().dataDirectory, configStore, workbuddy);
  serverManager = new ServerManager(configStore.publicPaths().dataDirectory, { systemScan, inspectInstance });
  serverManager.setLifecycleHooks({
    onReady: (config) => botManager.start(config),
    onStopped: () => botManager.stop()
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => workbuddy?.stopGateway());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('app:get-state', async () => {
  const config = configStore.load();
  return { config, paths: configStore.publicPaths(), platform: process.platform, recoveryNotice: configStore.consumeRecoveryNotice() };
});

ipcMain.handle('app:save-config', async (_event, payload) => {
  const config = payload.config;
  const stored = configStore.load();
  config.behavior.buildStewardMode = stored.behavior.buildStewardMode;
  config.server.lastBuildDirectory = stored.server.lastBuildDirectory;
  if (payload.apiKey !== undefined && payload.apiKey !== null) {
    config.model.hasApiKey = configStore.saveApiKey(String(payload.apiKey));
  }
  return configStore.save(config);
});

ipcMain.handle('dialog:directory', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, { title: title || '选择目录', properties: ['openDirectory'] });
  return result.canceled ? '' : result.filePaths[0];
});

ipcMain.handle('dialog:archive', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择整合包压缩包',
    properties: ['openFile'],
    filters: [{ name: '整合包', extensions: ['zip', 'mrpack', '7z'] }]
  });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('archive:prepare', (_event, archivePath) => archiveManager.prepare(archivePath));

ipcMain.handle('dialog:skin', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Minecraft 皮肤',
    properties: ['openFile'],
    filters: [{ name: 'PNG 皮肤', extensions: ['png'] }]
  });
  return result.canceled ? '' : result.filePaths[0];
});

ipcMain.handle('skin:read', (_event, target) => {
  const selected = target && fs.existsSync(target) ? target : '';
  if (!fs.existsSync(selected) || path.extname(selected).toLowerCase() !== '.png') return '';
  return `data:image/png;base64,${fs.readFileSync(selected).toString('base64')}`;
});

ipcMain.handle('skin:export-local', async (_event, source, playerName) => {
  const data = validateSkin(source, playerName);
  if (nativeImage.createFromBuffer(data).isEmpty()) throw new Error('皮肤文件损坏，无法打开。');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出给 CustomSkinLoader 使用',
    defaultPath: path.join(app.getPath('downloads'), `${playerName}.png`),
    filters: [{ name: 'Minecraft 皮肤', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { canceled: false, path: exportSkin(source, playerName, result.filePath) };
});

ipcMain.handle('skin:save-generated', (_event, dataUrl) => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('生成的皮肤数据无效。');
  const directory = path.join(configStore.publicPaths().dataDirectory, 'skins');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `jingban-skin-${Date.now()}.png`);
  fs.writeFileSync(target, Buffer.from(match[1], 'base64'));
  return target;
});

ipcMain.handle('system:scan', () => systemScan());
ipcMain.handle('voice:list', () => listSystemVoices());
ipcMain.handle('voice:preview', (_event, name) => previewSystemVoice(String(name || '')));
ipcMain.handle('game:inspect', (_event, instancePath) => inspectInstance(instancePath));
ipcMain.handle('workbuddy:status', () => process.env.WHALE_SCREENSHOT
  ? ({ available: true, signedIn: false, reason: '' })
  : workbuddy.status());
ipcMain.handle('workbuddy:models', () => workbuddy.models());
ipcMain.handle('build:open-window', () => { openBuildWindow(); return true; });
ipcMain.handle('build:get-state', () => buildPlanner.load());
ipcMain.handle('build:set-mode', (_event, mode) => buildPlanner.setMode(mode));
ipcMain.handle('build:send', (_event, message) => buildPlanner.send(message));
ipcMain.handle('build:clear', () => buildPlanner.clear());
ipcMain.handle('build:admin-execute', async () => {
  const commands = buildPlanner.adminCommands();
  return serverManager.executeAdminCommands(commands);
});
ipcMain.handle('build:discuss-with-agent', async () => {
  const state = buildPlanner.load();
  if (state.mode !== 'manual') throw new Error('请先切换到生存建造规划。');
  const user = [...state.messages].reverse().find((message) => message.role === 'user');
  const plan = [...state.messages].reverse().find((message) => message.role === 'assistant');
  if (!user) throw new Error('请先在窗口中输入建造需求。');
  const text = `玩家需求：${user.content}\n\n已有规划：${plan?.content || '尚未生成'}`.slice(0, 6000);
  const reply = await botManager.discussPlan(text);
  const current = buildPlanner.load();
  if (current.mode !== 'manual') throw new Error('模式已切换，请回到生存规划查看伙伴回复。');
  current.messages.push({ role: 'assistant', content: `【游戏伙伴】${reply}`, at: new Date().toISOString() });
  return buildPlanner.save(current);
});
ipcMain.handle('server:status', () => serverManager.status());
ipcMain.handle('server:set-administrator', async (_event, rawName, enabled) => {
  const name = String(rawName || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('玩家 ID 只能包含 1–16 位英文字母、数字或下划线。');
  if (typeof enabled !== 'boolean') throw new Error('权限操作无效。');
  const config = configStore.load();
  const list = config.server.administrators || [];
  const exists = list.some((entry) => entry.toLowerCase() === name.toLowerCase());
  if (enabled && !exists && list.length >= 100) throw new Error('管理员名单最多支持 100 人。');
  const status = serverManager.status();
  if (status.running && !status.ready) throw new Error('服务器正在启动或停止，请等服务器就绪后再修改权限。');
  if (status.ready) await serverManager.setAdministrator(name, enabled);
  config.server.administrators = list.filter((entry) => entry.toLowerCase() !== name.toLowerCase());
  config.server.revokedAdministrators = (config.server.revokedAdministrators || []).filter((entry) => entry.toLowerCase() !== name.toLowerCase());
  if (enabled) config.server.administrators.push(name);
  else config.server.revokedAdministrators.push(name);
  const saved = configStore.save(config);
  return { administrators: saved.server.administrators, applied: status.ready };
});
ipcMain.handle('server:build-start', async (_event, config) => {
  const status = await serverManager.buildAndStart(config);
  const stored = configStore.load();
  stored.server.lastBuildDirectory = status.serverDirectory || stored.server.lastBuildDirectory;
  configStore.save(stored);
  return status;
});
ipcMain.handle('server:stop', () => serverManager.stop());
ipcMain.handle('bot:status', () => botManager.status());
ipcMain.handle('bot:start', (_event, config) => botManager.start(config));
ipcMain.handle('bot:stop', () => botManager.stop());
ipcMain.handle('network:sakura-status', (_event, network) => sakuraFrp.status(network || configStore.load().network));
ipcMain.handle('network:sakura-open', async () => {
  const status = sakuraFrp.status();
  if (!status.launcherPath) return { ok: false, message: '未找到 SakuraFrp 启动器。' };
  const message = await shell.openPath(status.launcherPath);
  return { ok: message === '', message: message || 'SakuraFrp 已打开，请启动游戏 TCP 和语音 UDP 两条隧道。' };
});
ipcMain.handle('workbuddy:open-app', async () => {
  const executable = workbuddy.electronBinary();
  if (!executable) return { ok: false, message: '未找到 WorkBuddy 客户端，请先安装。' };
  const message = await shell.openPath(executable);
  return { ok: message === '', message: message || 'WorkBuddy 已打开，请登录后回到配置器点击“检测账号”。' };
});
ipcMain.handle('shell:open-path', (_event, target) => {
  if (!target || !fs.existsSync(target)) return '路径不存在';
  return shell.openPath(target);
});

ipcMain.handle('app:self-check', async (_event, config) => {
  const scan = await systemScan();
  const wb = config.model.channel === 'workbuddy' ? await workbuddy.status() : null;
  const sakura = config.network.mode === 'sakurafrp' ? sakuraFrp.status(config.network) : null;
  const instance = config.game.instancePath ? inspectInstance(config.game.instancePath) : { exists: false, voiceMods: [], worlds: [] };
  const modelOk = config.model.channel === 'workbuddy' ? Boolean(wb?.signedIn && config.model.workbuddyModel) : Boolean(config.model.baseUrl && config.model.modelId && config.model.hasApiKey);
  const gameOk = instance.exists;
  const compatibility = assessRuntimeCompatibility({ ...config.game, loaderVersion: config.game.loaderVersion || instance.loaderVersion });
  const worldOk = Boolean(config.game.worldPath && instance.worlds?.some((world) => world.path === config.game.worldPath));
  const runtimeProject = findBundledProject();
  const botRuntime = inspectBotRuntime(runtimeProject);
  const botProtocolOk = botRuntime.ok && botSupportsMinecraftVersion(runtimeProject, config.game.minecraftVersion);
  const template = resolveTemplate(config.server?.templatePath, [config.game.instancePath, instance.contentRoot].filter(Boolean), config.game);
  const runtimeOk = Boolean(findNodeExecutable() && botRuntime.ok && fs.existsSync(path.join(template, 'libraries')) && findWinArgs(template, config.game));
  const propertiesPath = template ? path.join(template, 'server.properties') : '';
  let offlineServer = false;
  try { offlineServer = /^\s*online-mode\s*=\s*false\s*$/mi.test(fs.readFileSync(propertiesPath, 'utf8')); } catch {}
  const javaSelection = selectJavaRuntime(scan, { ...config.game, javaMajor: config.game.javaMajor || instance.javaMajor });
  const personaNameOk = /^[A-Za-z0-9_]{1,16}$/.test(String(config.persona.name || ''));
  const portOk = Number.isInteger(Number(config.network.gameLocalPort)) && Number(config.network.gameLocalPort) >= 1 && Number(config.network.gameLocalPort) <= 65535
    && (!config.resources.voiceEnabled || (Number(config.network.voiceLocalPort) >= 1 && Number(config.network.voiceLocalPort) <= 65535 && Number(config.network.voiceLocalPort) !== Number(config.network.gameLocalPort)));
  const gamePortFree = serverManager.status().running || !portOk ? true : await isPortAvailable(Number(config.network.gameLocalPort));
  let chineseRecognizer = false;
  if (config.resources.voiceEnabled) { try { chineseRecognizer = await hasChineseRecognizer(); } catch {} }
  const checks = [
    { id: 'runtime', title: 'minebot与服务端运行环境', ok: runtimeOk, status: runtimeOk ? 'pass' : 'error', blocking: true, detail: runtimeOk ? '已找到匹配版本的服务端启动文件、AI 伙伴和内置 Node，不需要 Python' : '未找到匹配游戏与 Forge 版本的专用服务端 libraries/win_args.txt，请检查服务端目录和版本' },
    { id: 'server-auth', title: '伙伴身份验证', ok: offlineServer, status: offlineServer ? 'pass' : 'error', blocking: true, detail: offlineServer ? '服务端允许当前伙伴使用的离线身份；只应邀请信任的玩家' : '当前伙伴不支持正版身份登录；请选择允许离线身份的服务端，并只邀请信任的玩家' },
    { id: 'bot-protocol', title: 'AI 伙伴游戏协议', ok: botProtocolOk, status: botProtocolOk ? 'pass' : 'error', blocking: true, detail: botProtocolOk ? `内置伙伴数据已支持 Minecraft ${config.game.minecraftVersion}` : `当前内置伙伴数据不支持 Minecraft ${config.game.minecraftVersion || '未知'}，已在启动前拦截` },
    { id: 'model', title: 'AI 模型', ok: modelOk, status: modelOk ? 'pass' : 'error', blocking: true, detail: config.model.channel === 'workbuddy' ? (wb?.signedIn ? (config.model.workbuddyModel ? 'WorkBuddy 已登录，模型已选择' : 'WorkBuddy 已登录，请选择一个模型') : wb?.reason || '请先登录 WorkBuddy') : (modelOk ? '自备 API 配置完整' : '请补全 API 地址、模型名称和 API Key') },
    { id: 'game', title: '用户自有游戏环境', ok: gameOk, status: gameOk ? 'pass' : 'error', blocking: true, detail: instance.exists ? `已识别本地实例：${instance.minecraftVersion || config.game.minecraftVersion || '版本未知'} · ${instance.modLoader || config.game.modLoader}；原目录只读` : (config.game.archivePath ? '压缩包尚未成功验证和解压，请重新选择' : '尚未选择 PCL2 实例或本地整合包') },
    { id: 'compatibility', title: '游戏版本兼容性', ok: compatibility.ok, status: compatibility.ok ? 'pass' : 'error', blocking: true, detail: compatibility.detail },
    { id: 'world', title: '服务器世界存档', ok: worldOk, status: worldOk ? 'pass' : 'error', blocking: true, detail: worldOk ? `将复制 ${path.basename(config.game.worldPath)}；原世界保持不变` : '请在“游戏与整合包”页面选择要开服的世界' },
    { id: 'java', title: 'Java 运行时自动匹配', ok: Boolean(javaSelection.selected), status: javaSelection.selected ? 'pass' : 'error', blocking: true, detail: javaSelection.selected ? `已从 Minecraft/PCL 环境自动选择 Java ${javaSelection.expectedMajor} · ${javaSelection.selected.path}` : `当前游戏版本需要 Java ${javaSelection.expectedMajor || '对应版本'}，但未在 PCL/Minecraft 已有运行时中找到` },
    ...(config.resources.voiceEnabled
      ? [{ id: 'voice', title: '语音模组', ok: instance.voiceMods.length > 0, status: instance.voiceMods.length ? 'pass' : 'error', blocking: true, detail: instance.voiceMods.length ? `已发现 ${instance.voiceMods.join(', ')}` : '未找到 Simple Voice Chat；请自行安装匹配版本' }]
      : [{ id: 'voice', title: '语音模组（可选）', ok: true, status: instance.voiceMods.length ? 'optional' : 'optional', blocking: false, detail: instance.voiceMods.length ? `整合包已包含 ${instance.voiceMods.join(', ')}；当前未启用语音` : '当前未启用语音，不影响服务器构建' }]),
    ...(config.resources.voiceEnabled ? [{ id: 'voice-recognizer', title: '中文语音识别', ok: chineseRecognizer, status: chineseRecognizer ? 'pass' : 'pending', blocking: false, detail: chineseRecognizer ? '已发现 Windows 中文识别器；仍需实际测试麦克风和语音网络' : '未检测到 Windows 中文识别器：伙伴可能无法理解语音，但文字和语音播报仍可尝试' }] : []),
    { id: 'persona', title: '伙伴人设', ok: Boolean(personaNameOk && config.persona.description), status: personaNameOk && config.persona.description ? 'pass' : 'error', blocking: true, detail: !personaNameOk ? '游戏名称必须是 1–16 位英文字母、数字或下划线' : (config.persona.description ? config.persona.name : '请填写伙伴人设') },
    { id: 'ports', title: '本地端口', ok: portOk, status: portOk ? 'pass' : 'error', blocking: true, detail: portOk ? `游戏 TCP ${config.network.gameLocalPort}${config.resources.voiceEnabled ? `；语音 UDP ${config.network.voiceLocalPort}` : ''}` : '端口必须在 1–65535 之间，且游戏与语音端口不能相同' },
    { id: 'port-free', title: '游戏端口可用性', ok: gamePortFree, status: gamePortFree ? 'pass' : 'error', blocking: true, detail: gamePortFree ? `TCP ${config.network.gameLocalPort} 可用` : `TCP ${config.network.gameLocalPort} 已被其他程序占用；请关闭旧服务器或更换端口` },
    { id: 'network', title: '联机地址', ok: config.network.mode === 'lan' || (config.network.mode === 'sakurafrp' ? Boolean(sakura?.game?.running) : Boolean(config.network.gameAddress)), status: config.network.mode === 'lan' || (config.network.mode === 'sakurafrp' ? sakura?.game?.running : config.network.gameAddress) ? 'pass' : 'pending', blocking: false, detail: config.network.mode === 'lan' ? '局域网模式，无需外网地址' : config.network.mode === 'sakurafrp' ? (sakura?.game?.running ? `SakuraFrp 游戏 TCP 隧道在线：${sakura.game.address}${config.resources.voiceEnabled ? (sakura.voice?.running ? `；语音 UDP：${sakura.voice.address}` : '；语音 UDP 尚未在线') : ''}` : (sakura?.game?.address ? `SakuraFrp 当前已关闭；上次地址 ${sakura.game.address} 不会标记为可用` : '等待启动 SakuraFrp 游戏 TCP 隧道；不属于环境缺失')) : (config.network.gameAddress || '请填写现有公网地址') }
  ];
  const blockingFailures = checks.filter((check) => check.blocking && !check.ok);
  const pending = checks.filter((check) => check.status === 'pending');
  return { ready: blockingFailures.length === 0, checks, blockingFailures: blockingFailures.length, pending: pending.length, scannedAt: new Date().toISOString() };
});

