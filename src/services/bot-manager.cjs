const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

class BotManager {
  constructor(dataDirectory, workbuddy, configStore, options = {}) {
    this.root = path.join(dataDirectory, 'bot-runtime');
    this.project = options.project || findBundledProject();
    this.supportsVersion = options.supportsVersion || ((version) => botSupportsMinecraftVersion(this.project, version));
    this.workbuddy = workbuddy;
    this.configStore = configStore;
    this.child = null;
    this.output = null;
    this.startupTimer = null;
    this.recentOutput = '';
    this.state = { phase: 'idle', running: false, ready: false, pid: null, name: '', message: '伙伴尚未启动', logPath: '' };
  }

  status() {
    return { ...this.state, running: Boolean(this.child && this.child.exitCode === null) };
  }

  async start(config) {
    if (this.child && this.child.exitCode === null) return this.status();
    const name = config.persona.name || '';
    this.state = { ...this.state, phase: 'starting', running: false, ready: false, pid: null, name, message: '正在启动唯一的 AI 伙伴…' };
    try {
      const selectedModel = config.model.channel === 'workbuddy' ? config.model.workbuddyModel : config.model.modelId;
      if (!selectedModel) throw new Error('请先选择或填写模型。');
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('伙伴游戏名称只能使用 1–16 位英文字母、数字或下划线。');
      const entry = path.join(this.project, 'main.js');
      const sourceProfile = path.join(this.project, 'wb.json');
      const runtime = inspectBotRuntime(this.project);
      if (!runtime.ok) throw new Error(`伙伴运行环境不完整，缺少：${runtime.missing.join('、')}。请重新安装minebot，不需要另外安装 Python 或 Node。`);
      if (!this.supportsVersion(config.game?.minecraftVersion)) {
        throw new Error(`当前内置 AI 伙伴协议数据不支持 Minecraft ${config.game?.minecraftVersion || '未知'}。minebot不会尝试错误连接。`);
      }
      const node = findNodeExecutable();
      if (!node) throw new Error('未找到可用的 Node.js 运行时。');
      const gateway = config.model.channel === 'workbuddy'
        ? await this.workbuddy.startGateway()
        : await this.workbuddy.startApiGateway({ baseUrl: config.model.baseUrl, modelId: config.model.modelId, apiKey: this.configStore.readApiKey() });
    await fs.promises.mkdir(this.root, { recursive: true });
    const discoveryDirectory = path.join(this.root, 'workbuddy-shim');
    await fs.promises.mkdir(discoveryDirectory, { recursive: true });
    await writeJsonAtomic(path.join(discoveryDirectory, 'workbuddy.json'), gateway);
    const profile = JSON.parse(await fs.promises.readFile(sourceProfile, 'utf8'));
    profile.name = name;
    profile.model = `workbuddy/${selectedModel}`;
    profile.conversing = buildPersonaPrompt(profile.conversing, config);
    profile.proactive = Boolean(config.persona.proactive);
    profile.modes = {
      ...(profile.modes || {}),
      self_preservation: Boolean(config.behavior.selfPreservation),
      unstuck: Boolean(config.behavior.unstuck),
      self_defense: Boolean(config.behavior.selfDefense),
      hunting: Boolean(config.behavior.hunting),
      item_collecting: Boolean(config.behavior.itemCollecting),
      torch_placing: Boolean(config.behavior.torchPlacing),
      idle_staring: Boolean(config.behavior.idleStaring),
      cheat: Boolean(config.behavior.cheat)
    };
    const profilePath = path.join(this.root, 'active-profile.json');
    await writeJsonAtomic(profilePath, profile);
    const mindserverPort = await findAvailablePort();
    const logPath = path.join(this.root, 'bot-output.log');
    this.output = fs.createWriteStream(logPath, { flags: 'a' });
    this.recentOutput = '';
    this.output.write(`\n===== minebot启动 ${new Date().toISOString()} =====\n`);
    const env = {
      ...process.env,
      WORKBUDDY_SHIM_DIR: discoveryDirectory,
      MINECRAFT_PORT: String(config.network.gameLocalPort || 25565),
      MINDSERVER_PORT: String(mindserverPort),
      PROFILES: JSON.stringify([profilePath]),
      SETTINGS_JSON: JSON.stringify({ auto_open_ui: false, load_memory: true, minecraft_version: config.game.minecraftVersion, forge_server: config.game.modLoader === 'forge', voice_enabled: Boolean(config.resources?.voiceEnabled), voice_name: String(config.resources?.ttsVoice || '') })
    };
      // Mindcraft stores per-agent memory, histories and generated runtime files
      // below ./bots. Packaged builds live in Program Files, which is read-only
      // for normal users, so run it from our writable per-user runtime folder.
      // Source profiles and the entry point are already absolute paths.
      const child = spawn(node, [entry], { cwd: this.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.state = { ...this.state, running: true, pid: child.pid, logPath, message: `${name} 正在连接服务器…` };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      this.output?.write(text);
      this.recentOutput = `${this.recentOutput}${text}`.slice(-24000);
      if (this.state.phase === 'starting' && /\bspawned\./i.test(this.recentOutput)) {
        clearTimeout(this.startupTimer);
        this.state = { ...this.state, phase: 'ready', ready: true, message: `${name} 已进入游戏` };
      } else if (this.state.phase === 'starting' && /ECONNREFUSED|Network Error|Failed to connect/i.test(text)) {
        this.state = { ...this.state, message: `${name} 连接服务器失败，正在等待重试…` };
      }
      const diagnosis = diagnoseBotOutput(this.recentOutput);
      if (diagnosis && this.state.phase === 'starting') this.state = { ...this.state, message: diagnosis };
      if (this.state.phase === 'starting' && /Agent process exited too quickly and will not be restarted/i.test(this.recentOutput)) {
        clearTimeout(this.startupTimer);
        this.state = { ...this.state, phase: 'failed', ready: false, message: diagnosis || '伙伴进程启动后退出，请打开伙伴日志查看具体原因。' };
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(this.startupTimer);
      this.state = { ...this.state, phase: 'failed', running: false, ready: false, message: `伙伴启动失败：${error.message}` };
      this.finishOutput();
    });
    child.once('exit', (code) => {
      clearTimeout(this.startupTimer);
      const intentional = this.state.phase === 'stopping';
      const diagnosis = diagnoseBotOutput(this.recentOutput);
      this.state = { ...this.state, phase: intentional ? 'stopped' : 'failed', running: false, ready: false, pid: null, message: intentional ? '伙伴已退出游戏。' : (diagnosis || `伙伴进程已退出，退出码 ${code}。请打开伙伴日志查看详情。`) };
      this.child = null;
      this.finishOutput();
      this.workbuddy.stopGateway().catch(() => {});
    });
      this.startupTimer = setTimeout(() => {
        if (this.child === child && !this.state.ready) {
          this.state = { ...this.state, phase: 'failed', message: diagnoseBotOutput(this.recentOutput) || '伙伴连接超过 90 秒。请确认服务器已就绪、版本一致，并查看伙伴日志。' };
        }
      }, 90000);
      return this.status();
    } catch (error) {
      this.state = { ...this.state, phase: 'failed', running: false, ready: false, pid: null, message: `伙伴启动失败：${error.message}` };
      await this.workbuddy.stopGateway().catch(() => {});
      this.finishOutput();
      throw error;
    }
  }

  async stop() {
    clearTimeout(this.startupTimer);
    if (!this.child || this.child.exitCode !== null) {
      await this.workbuddy.stopGateway().catch(() => {});
      return this.status();
    }
    this.state = { ...this.state, phase: 'stopping', ready: false, message: '正在让伙伴退出游戏…' };
    this.child.kill();
    return this.status();
  }

  finishOutput() {
    this.output?.end();
    this.output = null;
  }
}

function findNodeExecutable() {
  const bundled = [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'node.exe'),
    path.join(__dirname, '..', '..', 'runtime', 'node.exe')
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
  if (bundled) return bundled;
  const versions = path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'versions');
  try {
    return fs.readdirSync(versions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(versions, entry.name, 'node.exe')))
      .map((entry) => path.join(versions, entry.name, 'node.exe'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || '';
  } catch { return ''; }
}

function findBundledProject() {
  return [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'mindcraft'),
    path.join(__dirname, '..', '..', 'runtime', 'mindcraft')
  ].filter(Boolean).find((candidate) => fs.existsSync(path.join(candidate, 'main.js'))) || '';
}

function inspectBotRuntime(project) {
  const required = ['main.js', 'wb.json', path.join('bots', 'lintTemplate.js'), path.join('bots', 'execTemplate.js')];
  const missing = required.filter((relative) => !fs.existsSync(path.join(project || '', relative)));
  return { ok: Boolean(project) && missing.length === 0, project, missing };
}

function botSupportsMinecraftVersion(project, minecraftVersion) {
  if (!project || !minecraftVersion) return false;
  try {
    const factory = require(path.join(project, 'node_modules', 'minecraft-data'));
    const data = factory(String(minecraftVersion));
    return Boolean(data?.version?.minecraftVersion && data?.blocksByName?.stone);
  } catch {
    return false;
  }
}

function diagnoseBotOutput(text) {
  const source = String(text || '');
  if (/EPERM: operation not permitted.*(?:last_profile|\\bots\\|\/bots\/)/i.test(source)) return '伙伴运行目录不可写。请更新minebot，新版会将伙伴记忆保存到用户数据目录。';
  if (/unexpected tag end|Parse error for play\.toClient/i.test(source)) return '伙伴无法解析某个模组的自定义网络数据。minebot已自动关闭已知的 ModernFix 增强配方同步；请查看日志确认是否还有其他协议模组。';
  if (/EADDRINUSE|address already in use/i.test(source)) return 'AI 伙伴的本机内部端口被占用。minebot已改为自动分配空闲端口；如仍出现，请关闭遗留的旧伙伴进程。';
  if (/401|unauthorized|invalid.*(?:token|key)/i.test(source)) return 'AI 模型鉴权失效。WorkBuddy 用户请重新登录；自备 API 用户请检查 API Key。';
  if (/ECONNREFUSED|Failed to connect|connect ETIMEDOUT/i.test(source)) return '伙伴暂时无法连接本地服务器。请等待服务器显示“已启动”，并确认本地端口一致。';
  if (/Failed to verify username|multiplayer\.disconnect\.unverified_username/i.test(source)) return '服务器要求正版身份验证，当前 AI 伙伴无法登录。请使用minebot已验证的本地服务器配置。';
  return '';
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function buildPersonaPrompt(fallback, config) {
  const persona = config.persona || {};
  const description = String(persona.description || '').trim();
  const replyStyle = String(persona.replyStyle || '').trim();
  if (!description && !replyStyle) return fallback;
  return `你是《我的世界》里的 AI 伙伴 $NAME。\n人设：${description || '可靠、友善的游戏伙伴。'}\n回复风格：${replyStyle || '简短、自然、使用简体中文'}。\n你必须诚实汇报执行结果，不得假装已经完成动作。\n$SELF_PROMPT\n记忆摘要：'$MEMORY'\n$STATS\n$INVENTORY\n$COMMAND_DOCS\n$EXAMPLES\n对话开始:`;
}

async function writeJsonAtomic(target, value) {
  const temp = `${target}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rm(target, { force: true });
  await fs.promises.rename(temp, target);
}

module.exports = { BotManager, findNodeExecutable, findBundledProject, inspectBotRuntime, botSupportsMinecraftVersion, findAvailablePort, diagnoseBotOutput, buildPersonaPrompt };
