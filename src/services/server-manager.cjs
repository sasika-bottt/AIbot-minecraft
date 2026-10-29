const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { normalizeAdministrators } = require('./config-store.cjs');
const { spawn } = require('node:child_process');

const SUPPORTED_RUNTIME = Object.freeze({ minecraftVersion: '1.20.1', modLoader: 'forge', forgeVersion: '47.4.23', javaMajor: 17 });

// Keep the server copy as close to the user's instance as possible. Only mods
// proven to crash a dedicated server are quarantined here; broadly removing
// client-looking mods can make an existing world lose registry/datapack data.
// Source packs stay untouched; only the generated server copy is filtered.
const CLIENT_ONLY_MOD_FRAGMENTS = [
  'oculus'
];

class ServerManager {
  constructor(dataDirectory, detector) {
    this.root = path.join(dataDirectory, 'server-workspace');
    this.detector = detector;
    this.child = null;
    this.output = null;
    this.lifecycle = {};
    this.readyNotified = false;
    this.recentOutput = '';
    this.stopWaiters = [];
    this.startupTimer = null;
    this.state = { phase: 'idle', ready: false, pid: null, message: '尚未启动', serverDirectory: '', logPath: '', mirrorPath: '', excludedMods: [], startedAt: null, exitCode: null };
  }

  status() {
    return { ...this.state, running: Boolean(this.child && this.child.exitCode === null) };
  }

  setLifecycleHooks(hooks = {}) {
    this.lifecycle = hooks;
  }

  async buildAndStart(config) {
    if (this.child && this.child.exitCode === null) throw new Error('服务器已经在运行。');
    const compatibility = assessRuntimeCompatibility(config.game);
    if (!compatibility.ok) {
      throw new Error(compatibility.detail);
    }
    await assertPortAvailable(Number(config.network.gameLocalPort) || 25565);
    this.state = { ...this.state, phase: 'building', ready: false, pid: null, message: '正在复制服务端运行环境和世界存档…', startedAt: new Date().toISOString(), exitCode: null };
    this.readyNotified = false;
    this.recentOutput = '';
    let prepared;
    let scan;
    let argsFile;
    try {
      prepared = await this.prepareWorkspace(config);
      scan = await this.detector.systemScan();
      const java = selectJavaRuntime(scan, config.game);
      if (!java.selected) throw new Error(`未在 Minecraft/PCL 已有运行时中找到 Java ${java.expectedMajor || '匹配版本'}。minebot不需要 Python 或 Node，也不会要求用户手填 Java 路径。`);
      scan.javaPath = java.selected.path;
      argsFile = findWinArgs(prepared.directory);
      if (!argsFile) throw new Error('服务端模板不完整：缺少 Forge win_args.txt。');
    } catch (error) {
      this.state = { ...this.state, phase: 'failed', ready: false, message: error.message || String(error) };
      throw error;
    }
    const logPath = path.join(prepared.directory, 'server-output.log');
    this.output = fs.createWriteStream(logPath, { flags: 'a' });
    const args = ['@user_jvm_args.txt', `@${path.relative(prepared.directory, argsFile).replaceAll('\\', '/')}`, 'nogui'];
    const child = spawn(scan.javaPath, args, { cwd: prepared.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const filterNote = prepared.excludedMods.length ? `，已隔离 ${prepared.excludedMods.length} 个客户端专用模组` : '';
    this.state = { ...this.state, phase: 'starting', message: `Forge 正在启动${filterNote}，首次加载可能需要几分钟…`, pid: child.pid, serverDirectory: prepared.directory, logPath, excludedMods: prepared.excludedMods };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      this.output?.write(text);
      this.recentOutput = `${this.recentOutput}${text}`.slice(-24000);
      if (/Done \([\d.]+s\)!/i.test(text)) {
        clearTimeout(this.startupTimer);
        this.state = { ...this.state, phase: 'ready', ready: true, message: `服务器已启动，本地端口 ${config.network.gameLocalPort || 25565}` };
        if (!this.readyNotified) {
          this.readyNotified = true;
          Promise.resolve(this.lifecycle.onReady?.(config)).catch(() => {});
        }
      }
      if (/Failed to bind to port|Address already in use/i.test(text)) this.state = { ...this.state, phase: 'failed', ready: false, message: '端口被占用，服务器无法启动。' };
      const diagnosis = diagnoseServerOutput(this.recentOutput);
      if (diagnosis && !this.state.ready) this.state = { ...this.state, message: diagnosis };
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(this.startupTimer);
      this.state = { ...this.state, phase: 'failed', ready: false, message: `服务器启动失败：${error.message}` };
      this.output?.end();
      this.resolveStopWaiters();
    });
    child.once('exit', async (code) => {
      clearTimeout(this.startupTimer);
      const wasReady = this.state.ready;
      this.output?.end();
      this.output = null;
      this.child = null;
      Promise.resolve(this.lifecycle.onStopped?.()).catch(() => {});
      if (code !== 0) {
        const diagnosis = diagnoseServerOutput(this.recentOutput);
        this.state = { ...this.state, phase: 'failed', ready: false, pid: null, exitCode: code, message: diagnosis || `${wasReady ? '服务器异常退出' : '服务器启动失败'}，退出码 ${code}。请查看服务器日志。` };
        this.resolveStopWaiters();
        return;
      }
      this.state = { ...this.state, phase: 'syncing', ready: false, pid: null, exitCode: code, message: '服务器已安全保存，正在更新当日单人存档…' };
      try {
        const mirror = await this.exportDailyWorld(prepared.directory, prepared.instanceRoot);
        this.state = { ...this.state, phase: 'stopped', message: `服务器已安全停止，单人存档已更新：${path.basename(mirror.path)}`, mirrorPath: mirror.path };
      } catch (error) {
        this.state = { ...this.state, phase: 'stopped', message: `服务器已安全停止，但单人存档更新失败：${error.message || error}` };
      }
      this.resolveStopWaiters();
    });
    this.startupTimer = setTimeout(() => {
      if (this.child === child && !this.state.ready) {
        this.state = { ...this.state, message: 'Forge 启动超过 5 分钟。请打开日志查看是否正在生成地形，或存在模组依赖错误。' };
      }
    }, 5 * 60 * 1000);
    return this.status();
  }

  async prepareWorkspace(config) {
    const selectedRoot = path.resolve(String(config.game.instancePath || ''));
    const inspected = this.detector.inspectInstance?.(selectedRoot);
    const instanceRoot = path.resolve(String(inspected?.contentRoot || selectedRoot));
    const savesRoot = path.resolve(instanceRoot, 'saves');
    const worldPath = path.resolve(String(config.game.worldPath || ''));
    const templateCandidate = resolveTemplate(config.server?.templatePath, [selectedRoot, instanceRoot], config.game);
    if (!templateCandidate) throw new Error('已找到游戏实例，但其中没有专用服务器启动文件。请选择包含 libraries 和 Forge win_args.txt 的本地服务端整合包；minebot不会把客户端 JAR 冒充服务端。');
    const template = path.resolve(templateCandidate);
    if (!instanceRoot || !fs.existsSync(instanceRoot)) throw new Error('游戏实例或整合包目录不存在，请重新选择。');
    const isInstanceWorld = isInside(savesRoot, worldPath);
    const isWorkBuddyWorld = samePath(worldPath, path.join(template, 'world'));
    if (!worldPath || (!isInstanceWorld && !isWorkBuddyWorld) || !fs.existsSync(path.join(worldPath, 'level.dat'))) {
      throw new Error('请先在“游戏与整合包”页面选择一个有效的世界存档。');
    }
    if (!fs.existsSync(path.join(template, 'libraries')) || !findWinArgs(template)) {
      throw new Error('当前本地服务端环境不完整：缺少 libraries 或 Forge win_args.txt。');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = path.join(this.root, 'builds', stamp);
    await fs.promises.mkdir(directory, { recursive: true });
    const excluded = new Set(['world', 'logs', 'crash-reports', 'backups', 'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts']);
    await fs.promises.cp(template, directory, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(template, source);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return !excluded.has(first) && !['server_console.log', 'server-output.log'].includes(path.basename(source));
      }
    });
    await fs.promises.cp(worldPath, path.join(directory, 'world'), { recursive: true });
    const excludedMods = [];
    const modsSource = path.join(instanceRoot, 'mods');
    const modsTarget = path.join(directory, 'mods');
    if (fs.existsSync(modsSource)) {
      await fs.promises.mkdir(modsTarget, { recursive: true });
      for (const entry of await fs.promises.readdir(modsSource, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
        const reason = clientOnlyModReason(entry.name);
        if (reason) {
          excludedMods.push({ name: entry.name, reason });
          continue;
        }
        await fs.promises.copyFile(path.join(modsSource, entry.name), path.join(modsTarget, entry.name));
      }
    }
    for (const folder of ['config', 'defaultconfigs', 'kubejs', 'scripts']) {
      const source = path.join(instanceRoot, folder);
      if (fs.existsSync(source)) await fs.promises.cp(source, path.join(directory, folder), { recursive: true, force: true });
    }
    await setPropertyOverride(
      path.join(directory, 'config', 'modernfix-mixins.properties'),
      'mixin.perf.smart_ingredient_sync',
      'false'
    );
    if (config.resources?.voiceEnabled) {
      await setPropertyOverride(
        path.join(directory, 'config', 'voicechat', 'voicechat-server.properties'),
        'port',
        String(Number(config.network.voiceLocalPort) || 24454)
      );
    }
    const jvmArgsPath = path.join(directory, 'user_jvm_args.txt');
    if (!fs.existsSync(jvmArgsPath)) await fs.promises.writeFile(jvmArgsPath, '-Xms1G\n-Xmx4G\n', 'utf8');
    await fs.promises.writeFile(path.join(directory, 'eula.txt'), 'eula=true\n', 'utf8');
    const propertiesPath = path.join(directory, 'server.properties');
    const existing = fs.existsSync(propertiesPath) ? await fs.promises.readFile(propertiesPath, 'utf8') : '';
    const properties = updateProperties(existing, {
      'level-name': 'world',
      'server-port': String(Number(config.network.gameLocalPort) || 25565),
      'query.port': String(Number(config.network.gameLocalPort) || 25565),
      'enable-rcon': 'false',
      'motd': `minebot · ${path.basename(worldPath)}`
    });
    await fs.promises.writeFile(propertiesPath, properties, 'utf8');
    {
      const offline = /^online-mode\s*=\s*false\s*$/mi.test(properties);
      const opsPath = path.join(directory, 'ops.json');
      let operators = [];
      if (fs.existsSync(opsPath)) {
        operators = JSON.parse(await fs.promises.readFile(opsPath, 'utf8'));
        if (!Array.isArray(operators)) throw new Error('服务端模板中的管理员名单格式无效，请检查 ops.json。');
      }
      const revoked = new Set(normalizeAdministrators(config.server?.revokedAdministrators).map((name) => name.toLowerCase()));
      operators = operators.filter((operator) => !revoked.has(String(operator.name || '').toLowerCase()));
      for (const name of normalizeAdministrators(config.server?.administrators)) {
        let uuid = offline ? offlinePlayerUuid(name) : '';
        if (!offline && fs.existsSync(path.join(directory, 'usercache.json'))) {
          const cache = JSON.parse(await fs.promises.readFile(path.join(directory, 'usercache.json'), 'utf8'));
          uuid = cache.find((player) => String(player.name).toLowerCase() === name.toLowerCase())?.uuid || '';
        }
        if (!offline && !uuid && config.server?.lastBuildDirectory) {
          const previousOps = path.join(config.server.lastBuildDirectory, 'ops.json');
          if (fs.existsSync(previousOps)) {
            const previous = JSON.parse(await fs.promises.readFile(previousOps, 'utf8'));
            uuid = previous.find((operator) => String(operator.name).toLowerCase() === name.toLowerCase())?.uuid || '';
          }
        }
        if (!uuid) throw new Error(`无法确定管理员 ${name} 的正版账号身份。请使用包含该玩家身份缓存的服务端模板。`);
        const existing = operators.find((operator) => operator.uuid === uuid);
        if (existing) { existing.name = name; existing.level = 4; }
        else operators.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
      }
      await fs.promises.writeFile(opsPath, `${JSON.stringify(operators, null, 2)}\n`, 'utf8');
    }
    await fs.promises.writeFile(path.join(directory, 'build-info.json'), `${JSON.stringify({ sourceInstance: instanceRoot, sourceWorld: worldPath, template, excludedMods, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    return { directory, worldPath, excludedMods, instanceRoot };
  }

  stop() {
    if (!this.child || this.child.exitCode !== null) return this.status();
    this.state = { ...this.state, phase: 'stopping', message: '正在保存世界并停止服务器…' };
    if (this.child.stdin?.writable) this.child.stdin.write('stop\n');
    return this.status();
  }

  async stopAndWait(timeoutMs = 90000) {
    if (!this.child || this.child.exitCode !== null) return this.status();
    this.stop();
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (status) => { clearTimeout(timer); resolve(status); } };
      const timer = setTimeout(() => {
        this.stopWaiters = this.stopWaiters.filter((candidate) => candidate !== waiter);
        reject(new Error('服务器在 90 秒内未完成保存，已取消退出。请查看日志，不要强制结束 Java。'));
      }, timeoutMs);
      this.stopWaiters.push(waiter);
    });
  }

  resolveStopWaiters() {
    const waiters = this.stopWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(this.status());
  }

  async setAdministrator(name, enabled) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('玩家 ID 只能包含 1–16 位英文字母、数字或下划线。');
    if (!this.child || this.child.exitCode !== null || !this.state.ready || !this.child.stdin?.writable) throw new Error('服务器尚未就绪，无法即时修改管理员权限。');
    const opsPath = path.join(this.state.serverDirectory, 'ops.json');
    const props = await fs.promises.readFile(path.join(this.state.serverDirectory, 'server.properties'), 'utf8');
    const offline = /^online-mode\s*=\s*false\s*$/mi.test(props);
    const cachePath = path.join(this.state.serverDirectory, 'usercache.json');
    let cache = [];
    try { cache = JSON.parse(await fs.promises.readFile(cachePath, 'utf8')); } catch { /* No cached identities yet. */ }
    const expectedUuid = offline ? offlinePlayerUuid(name) : '';
    const identity = cache.find((player) => player.name === name && (!offline || player.uuid === expectedUuid));
    if (!identity) throw new Error(`尚未确认玩家 ${name} 的准确身份。请让该玩家使用大小写完全一致的 ID 先加入服务器，再设置或移除权限。`);
    this.child.stdin.write(`${enabled ? 'op' : 'deop'} ${name}\n`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const list = JSON.parse(await fs.promises.readFile(opsPath, 'utf8'));
        const present = list.some((operator) => operator.uuid === identity.uuid);
        if (present === enabled) return { ok: true };
      } catch { /* Wait for the server to persist the change. */ }
    }
    throw new Error('服务器未确认权限变更。请确认玩家 ID 正确且该玩家曾进入服务器，再查看服务器日志。');
  }

  async executeAdminCommands(commands) {
    if (!this.child || this.child.exitCode !== null || !this.state.ready) throw new Error('服务器尚未就绪，不能执行管理员施工。');
    const validated = validateAdminCommands(commands);
    const world = path.join(this.state.serverDirectory, 'world');
    if (!fs.existsSync(path.join(world, 'level.dat'))) throw new Error('当前服务器世界不完整，已拒绝执行。');
    const backup = path.join(this.state.serverDirectory, 'backups', `admin-${formatLocalTimestamp(new Date())}`);
    this.child.stdin.write('save-off\n');
    this.child.stdin.write('save-all flush\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      await fs.promises.mkdir(path.dirname(backup), { recursive: true });
      await fs.promises.cp(world, backup, { recursive: true, errorOnExist: true, force: false });
      if (!fs.existsSync(path.join(backup, 'level.dat'))) throw new Error('施工前备份校验失败。');
    } finally {
      this.child.stdin.write('save-on\n');
    }
    for (const command of validated) this.child.stdin.write(`${command.replace(/^\//, '')}\n`);
    this.child.stdin.write('save-all flush\n');
    return { ok: true, commandCount: validated.length, backupPath: backup, message: `已执行 ${validated.length} 条受控建造命令；施工前备份已保存。` };
  }

  async exportDailyWorld(serverDirectory, instancePath, now = new Date()) {
    const source = path.resolve(serverDirectory, 'world');
    const savesRoot = path.resolve(String(instancePath || ''), 'saves');
    if (!fs.existsSync(path.join(source, 'level.dat'))) throw new Error('服务器世界不完整，缺少 level.dat。');
    if (!fs.existsSync(savesRoot)) throw new Error('PCL2 实例的 saves 目录不存在。');
    const dateName = formatLocalDate(now);
    const targetName = `境伴-${dateName}`;
    const target = path.join(savesRoot, targetName);
    const stamp = formatLocalTimestamp(now);
    const stage = path.join(savesRoot, `.${targetName}.sync-${stamp}`);
    const previous = path.join(savesRoot, `.${targetName}.previous-${stamp}`);
    await fs.promises.cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    if (!fs.existsSync(path.join(stage, 'level.dat'))) throw new Error('单人存档临时副本校验失败。');
    await renameWorldDisplayName(path.join(stage, 'level.dat'), targetName);
    let previousPath = '';
    try {
      if (fs.existsSync(target)) {
        await fs.promises.rename(target, previous);
        previousPath = previous;
      }
      await fs.promises.rename(stage, target);
      if (previousPath) await fs.promises.rm(previousPath, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(target) && previousPath && fs.existsSync(previousPath)) {
        await fs.promises.rename(previousPath, target).catch(() => {});
      }
      throw error;
    }
    return { path: target };
  }
}

async function renameWorldDisplayName(levelPath, displayName) {
  const compressed = await fs.promises.readFile(levelPath);
  let source;
  try { source = zlib.gunzipSync(compressed); } catch { return false; }
  const tagName = Buffer.from('LevelName', 'utf8');
  const marker = Buffer.concat([Buffer.from([8, 0, tagName.length]), tagName]);
  const index = source.indexOf(marker);
  if (index < 0) return false;
  const lengthOffset = index + marker.length;
  if (lengthOffset + 2 > source.length) return false;
  const oldLength = source.readUInt16BE(lengthOffset);
  const valueOffset = lengthOffset + 2;
  if (valueOffset + oldLength > source.length) return false;
  const replacement = Buffer.from(displayName, 'utf8');
  if (replacement.length > 65535) throw new Error('单人世界名称过长。');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(replacement.length);
  const updated = Buffer.concat([
    source.subarray(0, lengthOffset),
    length,
    replacement,
    source.subarray(valueOffset + oldLength)
  ]);
  const temp = `${levelPath}.name-sync`;
  await fs.promises.writeFile(temp, zlib.gzipSync(updated));
  await fs.promises.rename(temp, levelPath);
  return true;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalTimestamp(date) {
  return `${formatLocalDate(date)}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function offlinePlayerUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function findWinArgs(directory) {
  const forgeRoot = path.join(directory, 'libraries', 'net', 'minecraftforge', 'forge');
  if (!fs.existsSync(forgeRoot)) return '';
  for (const version of fs.readdirSync(forgeRoot)) {
    const candidate = path.join(forgeRoot, version, 'win_args.txt');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function resolveTemplate(configured = '', localCandidates = [], game = {}) {
  const local = [configured, ...localCandidates, ...localCandidates.map((candidate) => path.dirname(candidate))]
    .filter(Boolean)
    .find((candidate) => fs.existsSync(path.join(candidate, 'libraries')) && Boolean(findWinArgs(candidate)));
  if (local) return local;
  const bundled = [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'server-template'),
    path.join(__dirname, '..', '..', 'runtime', 'server-template')
  ].filter(Boolean).find((candidate) => fs.existsSync(path.join(candidate, 'libraries')));
  const canUseBundled = String(game.minecraftVersion || SUPPORTED_RUNTIME.minecraftVersion) === SUPPORTED_RUNTIME.minecraftVersion
    && String(game.modLoader || SUPPORTED_RUNTIME.modLoader).toLowerCase() === SUPPORTED_RUNTIME.modLoader;
  return canUseBundled ? (bundled || '') : '';
}

function clientOnlyModReason(filename) {
  const normalized = String(filename || '').toLowerCase();
  const fragment = CLIENT_ONLY_MOD_FRAGMENTS.find((candidate) => normalized.includes(candidate));
  return fragment ? `专用服务器不兼容规则：${fragment}` : '';
}

async function setPropertyOverride(target, key, value) {
  if (!fs.existsSync(target)) return false;
  const source = await fs.promises.readFile(target, 'utf8');
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
  const line = `${key}=${value}`;
  const updated = matcher.test(source) ? source.replace(matcher, line) : `${source.replace(/\\s*$/, '')}\n${line}\n`;
  await fs.promises.writeFile(target, updated, 'utf8');
  return true;
}

function updateProperties(source, changes) {
  const seen = new Set();
  const lines = String(source || '').split(/\r?\n/).map((line) => {
    const match = /^([^#!=]+)=(.*)$/.exec(line);
    if (!match || !(match[1] in changes)) return line;
    seen.add(match[1]);
    return `${match[1]}=${changes[match[1]]}`;
  });
  for (const [key, value] of Object.entries(changes)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`;
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`端口 ${port} 已被占用，请停止现有服务器或更换端口。`)));
    server.once('listening', () => server.close(resolve));
    server.listen(port, '0.0.0.0');
  });
}

async function isPortAvailable(port) {
  try { await assertPortAvailable(port); return true; } catch { return false; }
}

function assessRuntimeCompatibility(game = {}) {
  const minecraftVersion = String(game.minecraftVersion || '').trim();
  const modLoader = String(game.modLoader || '').trim().toLowerCase();
  if (!minecraftVersion || !modLoader) {
    return {
      ok: false,
      detail: '请从用户自有实例中选择 Minecraft 版本和模组加载器。'
    };
  }
  if (modLoader !== 'forge') {
    return {
      ok: false,
      detail: `已识别 Minecraft ${minecraftVersion} + ${modLoader}。当前服务器构建器先支持 Forge，不会对其他加载器进行错误构建。`
    };
  }
  return { ok: true, detail: `已按用户选择配置 Minecraft ${minecraftVersion} + Forge ${game.loaderVersion || '版本自动识别'}` };
}

function expectedJavaMajor(minecraftVersion) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(minecraftVersion || ''));
  if (!match) return 0;
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function selectJavaRuntime(scan = {}, game = {}) {
  const expectedMajor = expectedJavaMajor(game.minecraftVersion) || Number(game.javaMajor);
  const candidates = Array.isArray(scan.javaCandidates) ? scan.javaCandidates : [];
  const selected = candidates.find((candidate) => candidate.major === expectedMajor)
    || (scan.javaPath && scan.javaMajor === expectedMajor ? { path: scan.javaPath, version: scan.java, major: scan.javaMajor, source: scan.javaSource } : null);
  return { expectedMajor, selected, candidates };
}

function diagnoseServerOutput(text) {
  const source = String(text || '');
  if (/OutOfMemoryError|Could not reserve enough space/i.test(source)) return '服务器内存不足。请关闭占用内存的程序，或降低 user_jvm_args.txt 中的最大内存。';
  if (/UnsupportedClassVersionError|class file version/i.test(source)) return 'Java 版本不匹配。Minecraft 1.20.1 Forge 需要 Java 17。';
  if (/Attempted to load class .* for invalid dist DEDICATED_SERVER|invalid dist DEDICATED_SERVER/i.test(source)) return '发现客户端专用模组导致服务端崩溃。原整合包未被修改；请查看日志中紧邻该错误的模组名。';
  if (/Mod .+ requires|Missing or unsupported mandatory dependencies|Failure message:/i.test(source)) return '模组依赖不完整或版本不兼容。请根据服务器日志中的“requires”信息补齐同版本依赖。';
  if (/Failed to bind to port|Address already in use/i.test(source)) return '服务器端口已被占用。请先停止旧服务器，或在联机设置中换一个本地端口。';
  if (/Failed to load datapacks|Errors in currently selected datapacks/i.test(source)) return '世界存档依赖的数据包或模组缺失。minebot已保留原存档，请先核对整合包内容。';
  return '';
}

function validateAdminCommands(commands) {
  if (!Array.isArray(commands) || !commands.length) throw new Error('方案中没有找到可执行的 /fill、/setblock 或 /clone 命令。');
  if (commands.length > 64) throw new Error('单次施工最多允许 64 条命令。');
  return commands.map((raw) => {
    const command = String(raw || '').trim();
    if (!/^\/(fill|setblock|clone)\s+/i.test(command)) throw new Error(`不允许的施工命令：${command.slice(0, 40)}`);
    if (command.length > 320 || /[\r\n;]|\b(execute|function|op|deop|stop|reload)\b/i.test(command)) throw new Error('施工命令包含不安全内容。');
    const parts = command.split(/\s+/);
    if (parts[0].toLowerCase() === '/fill') {
      const coordinates = parts.slice(1, 7).map(parseCoordinate);
      if (coordinates.some((value) => value === null)) throw new Error('fill 命令必须使用明确的数字或相对坐标。');
      const volume = (Math.abs(coordinates[3] - coordinates[0]) + 1) * (Math.abs(coordinates[4] - coordinates[1]) + 1) * (Math.abs(coordinates[5] - coordinates[2]) + 1);
      if (volume > 32768) throw new Error(`单条 fill 命令预计修改 ${volume} 个方块，超过 32768 的安全上限。`);
    }
    return command;
  });
}

function parseCoordinate(value) {
  const match = /^(?:~(-?\d+)?|(-?\d+))$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1] || match[2] || 0);
}

module.exports = { ServerManager, SUPPORTED_RUNTIME, CLIENT_ONLY_MOD_FRAGMENTS, clientOnlyModReason, setPropertyOverride, resolveTemplate, findWinArgs, assessRuntimeCompatibility, selectJavaRuntime, isPortAvailable, diagnoseServerOutput, validateAdminCommands, updateProperties, renameWorldDisplayName, offlinePlayerUuid };
