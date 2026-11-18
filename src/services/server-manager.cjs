const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const os = require('node:os');
const { normalizeAdministrators } = require('./config-store.cjs');
const { spawn } = require('node:child_process');
const yauzl = require('yauzl');
const { ensureRuntime, ensureJava, launchArgs, isTemplateCompatible, resolveLoaderVersion } = require('./server-runtime.cjs');
const { prepareVoiceMods } = require('./managed-mods.cjs');
const { selectWorld, worldManifest, manifestsEqual, recordSession, writeJson, readJson } = require('./world-recovery.cjs');
const { prepareModDependencies } = require('./mod-health.cjs');
const { probeServer } = require('./server-probe.cjs');

const SUPPORTED_RUNTIME = Object.freeze({ minecraftVersion: '1.20.1', modLoader: 'forge', forgeVersion: '47.4.23', javaMajor: 17 });

// Keep the server copy as close to the user's instance as possible. Only mods
// proven to crash a dedicated server are quarantined here; broadly removing
// client-looking mods can make an existing world lose registry/datapack data.
// Source packs stay untouched; only the generated server copy is filtered.
const CLIENT_ONLY_MOD_FRAGMENTS = [
  'oculus'
];

function isSessionArtifact(name) {
  return name === 'build-info.json' || /^\.minebot-(?:clean-stop|session|sync|world-baseline)(?:\.|$)/i.test(name);
}

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
    this.sessionWrites = Promise.resolve();
    this.state = { phase: 'idle', ready: false, pid: null, message: '尚未启动', serverDirectory: '', logPath: '', mirrorPath: '', excludedMods: [], startedAt: null, exitCode: null };
  }

  status() {
    return { ...this.state, busy: Boolean(this.startPromise) || this.state.phase === 'syncing', running: Boolean(this.child && this.child.exitCode === null) };
  }

  setLifecycleHooks(hooks = {}) {
    this.lifecycle = hooks;
  }

  async restoreStatus(config) {
    const directory = String(config.server?.lastBuildDirectory || '');
    const relative = path.relative(path.join(this.root, 'builds'), path.resolve(directory || '.'));
    if (!directory || !relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 1 || !fs.existsSync(path.join(directory, 'build-info.json'))) return;
    const sync = await readJson(path.join(directory, '.minebot-sync.json'));
    const saved = fs.existsSync(path.join(directory, '.minebot-clean-stop'));
    this.state = { ...this.state, serverDirectory: directory, logPath: path.join(directory, 'server-output.log'), syncFailed: saved && sync?.phase !== 'complete', message: saved ? '上次世界已保存，可以继续启动；单人存档可重新同步。' : '上次运行记录已保留；再次启动时会自动判断并备份恢复。' };
  }

  progress(message, stage = 'prepare') {
    const history = [...(this.state.history || []), { stage, message, at: new Date().toISOString() }].slice(-60);
    this.state = { ...this.state, message, stage, history };
  }

  journal(directory, update) {
    this.sessionWrites = this.sessionWrites.catch(() => {}).then(() => recordSession(directory, update));
    return this.sessionWrites;
  }

  async prepareEnvironment(config) {
    if (!config.game.instancePath || !fs.existsSync(config.game.instancePath)) throw new Error('所选游戏目录已移动或不存在。请重新选择当前游戏实例；旧服务器世界仍保存在工作目录。');
    if (config.game.modLoader !== 'vanilla' && !config.game.loaderVersion) {
      this.progress('正在查询官方兼容的加载器版本…', 'version');
      config.game.loaderVersion = await resolveLoaderVersion(config.game);
    }
    this.state = { ...this.state, resolvedGame: { ...config.game } };
    const java = selectJavaRuntime(await this.detector.systemScan(), config.game);
    this.progress(java.selected ? `已匹配 Java ${java.expectedMajor}。` : `正在自动准备 Java ${java.expectedMajor}…`, 'java');
    const javaPath = java.selected?.path || await ensureJava(path.join(this.root, 'javas'), java.expectedMajor);
    const inspected = this.detector.inspectInstance?.(config.game.instancePath);
    if (!config.game.instancePath || !fs.existsSync(config.game.instancePath)) throw new Error('所选游戏目录已移动或不存在。请重新选择当前游戏实例；旧服务器世界仍保存在恢复中心。');
    const roots = [config.game.instancePath, inspected?.contentRoot].filter(Boolean);
    let template = resolveTemplate(config.server?.templatePath, roots, config.game);
    if (template && !await isTemplateCompatible(template, config.game)) template = '';
    if (!template) {
      this.progress('正在准备所选版本的服务端和依赖，网络中断时会自动重试…', 'runtime');
      template = await ensureRuntime(path.join(this.root, 'runtimes'), config.game, javaPath, update => this.progress(update.message, 'runtime'));
    }
    this.preparedEnvironment = { javaPath, template, identity: JSON.stringify(config.game) };
    return this.preparedEnvironment;
  }

  async prepareOnly(config) {
    if (this.startPromise || this.status().running || this.state.phase === 'syncing') throw new Error('服务器正在运行或处理存档，请稍后准备资源。');
    this.startPromise = this.prepareEnvironment(config);
    try { await this.startPromise; this.progress('必要运行资源已准备好，可以构建服务器。', 'prepared'); return this.status(); }
    catch (error) { this.state = { ...this.state, phase: 'failed', message: error.message }; throw error; }
    finally { this.startPromise = null; }
  }

  async buildAndStart(config) {
    if (this.startPromise || this.state.phase === 'syncing') throw new Error('服务器正在构建或同步存档，请等待完成。');
    this.startPromise = this.startOnce(config);
    try { return await this.startPromise; }
    catch (error) { if (!this.status().running) this.state = { ...this.state, phase: 'failed', ready: false, message: error.message, errorCode: error.code || '', recovery: error.backupPath ? { backupPath: error.backupPath, needsChoice: true } : this.state.recovery }; throw error; }
    finally { this.startPromise = null; }
  }

  async startOnce(config) {
    if (this.child && this.child.exitCode === null) throw new Error('服务器已经在运行。');
    const compatibility = assessRuntimeCompatibility(config.game);
    if (!compatibility.ok) {
      throw new Error(compatibility.detail);
    }
    await assertPortAvailable(Number(config.network.gameLocalPort) || 25565);
    this.state = { ...this.state, phase: 'building', ready: false, pid: null, message: '正在检查并准备服务器…', history: [], recovery: null, modPreparation: null, errorCode: '', syncFailed: false, mirrorPath: '', startedAt: new Date().toISOString(), exitCode: null };
    this.readyNotified = false;
    this.recentOutput = '';
    let prepared;
    this.readinessProbe = null;
    let scan;
    let startArgs;
    try {
      const environment = await this.prepareEnvironment(config);
      scan = { javaPath: environment.javaPath };
      this.progress('正在检查世界续接并创建独立服务器副本…', 'world');
      prepared = await this.prepareWorkspace(config, environment.template);
      startArgs = launchArgs(prepared.directory, config.game);
      if (!startArgs) throw new Error('服务端运行环境不完整，请检查所选版本和加载器。');
    } catch (error) {
      this.state = { ...this.state, phase: 'failed', ready: false, message: error.message || String(error) };
      throw error;
    }
    const logPath = path.join(prepared.directory, 'server-output.log');
    await this.journal(prepared.directory, { phase: 'launching', pid: null, everReady: false });
    this.output = fs.createWriteStream(logPath, { flags: 'a' });
    const child = (this.detector.spawn || spawn)(scan.javaPath, startArgs, { cwd: prepared.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.journal(prepared.directory, { phase: 'launching', pid: child.pid || null }).catch(() => {});
    const filterNote = prepared.excludedMods.length ? `，已隔离 ${prepared.excludedMods.length} 个客户端专用模组` : '';
    this.state = { ...this.state, phase: 'starting', message: `服务器正在启动${filterNote}，首次加载可能需要几分钟…`, pid: child.pid, serverDirectory: prepared.directory, logPath, excludedMods: prepared.excludedMods };
    const onData = (chunk) => {
      if (this.child !== child) return;
      const text = chunk.toString('utf8');
      this.output?.write(text);
      this.recentOutput = `${this.recentOutput}${text}`.slice(-24000);
      if (/Done \([\d.]+s\)!/i.test(this.recentOutput) && !this.readyNotified) {
        if (!this.readinessProbe) this.readinessProbe = (async () => {
          let response;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (this.child !== child || child.exitCode !== null || this.state.phase === 'stopping') return;
            try { response = await (this.detector.probeServer || probeServer)(Number(config.network.gameLocalPort) || 25565); break; }
            catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
          }
          if (this.child !== child || child.exitCode !== null || this.state.phase === 'stopping') return;
          clearTimeout(this.startupTimer); this.readyNotified = true;
          this.state = { ...this.state, phase: 'ready', ready: true, probe: response, message: `游戏服务器已验证可连接，本地端口 ${config.network.gameLocalPort || 25565}` };
          await this.journal(prepared.directory, { phase: 'ready', everReady: true });
          Promise.resolve().then(() => this.lifecycle.onReady?.(config)).catch(() => {});
        })().catch(error => { if (this.child === child) this.state = { ...this.state, message: `游戏日志已就绪，但本机连接尚未验证：${error.message}。可打开日志检查或正常停服重试。` }; });
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
      this.child = null;
      this.journal(prepared.directory, { phase: 'failed', pid: null, error: error.message }).catch(() => {});
      this.resolveStopWaiters();
    });
    child.once('close', async (code) => {
      if (this.child !== child) return;
      clearTimeout(this.startupTimer);
      const wasReady = this.readyNotified;
      this.output?.end();
      this.output = null;
      this.child = null;
      this.state = { ...this.state, phase: 'syncing', ready: false, pid: null, message: '正在核对退出结果并保存运行记录…' };
      Promise.resolve().then(() => this.lifecycle.onStopped?.()).catch(() => {});
      if (code !== 0) {
        await this.journal(prepared.directory, { phase: 'failed', pid: null, exitCode: code }).catch(() => {});
        const diagnosis = diagnoseServerOutput(this.recentOutput);
        this.state = { ...this.state, phase: 'failed', ready: false, pid: null, exitCode: code, message: diagnosis || `${wasReady ? '服务器异常退出' : '服务器启动失败'}，退出码 ${code}。请查看服务器日志。` };
        this.resolveStopWaiters();
        return;
      }
      if (!wasReady) {
        await this.journal(prepared.directory, { phase: 'failed', pid: null, exitCode: code }).catch(() => {});
        this.state = { ...this.state, phase: 'failed', ready: false, pid: null, exitCode: code, message: '服务器未完成启动，已保留工作目录供检查。' };
        this.resolveStopWaiters();
        return;
      }
      this.state = { ...this.state, phase: 'syncing', ready: false, pid: null, exitCode: code, message: '服务器已安全保存，正在更新当日单人存档…' };
      try {
        if (!/All dimensions are saved|All chunks are saved|Saving chunks for level|Saved the world/i.test(this.recentOutput)) throw new Error('进程已退出，但日志未确认世界写入完成；下次启动会自动备份并校验恢复。');
        await fs.promises.writeFile(path.join(prepared.directory, '.minebot-clean-stop'), new Date().toISOString(), 'utf8');
        await this.journal(prepared.directory, { phase: 'saved', pid: null, exitCode: code });
        const mirror = await this.exportDailyWorld(prepared.directory, prepared.instanceRoot);
        await this.lifecycle.onWorldExported?.(mirror.path, prepared.instanceRoot);
        this.state = { ...this.state, phase: 'stopped', syncFailed: false, message: `服务器已安全停止，单人存档已更新：${path.basename(mirror.path)}`, mirrorPath: mirror.path };
      } catch (error) {
        this.state = { ...this.state, phase: 'stopped', syncFailed: true, message: `服务器已停止，存档同步需要处理：${error.message || error}` };
      }
      this.resolveStopWaiters();
    });
    this.startupTimer = setTimeout(() => {
      if (this.child === child && !this.state.ready) {
        this.state = { ...this.state, message: '服务器仍在启动，已超过 5 分钟。请查看启动步骤与日志；不要强制结束正在保存的进程。' };
      }
    }, 5 * 60 * 1000);
    return this.status();
  }

  async prepareWorkspace(config, runtimeTemplate = '') {
    const selectedRoot = path.resolve(String(config.game.instancePath || ''));
    const inspected = this.detector.inspectInstance?.(selectedRoot);
    const instanceRoot = path.resolve(String(inspected?.contentRoot || selectedRoot));
    const savesRoot = path.resolve(instanceRoot, 'saves');
    const worldPath = config.game.worldPath ? path.resolve(String(config.game.worldPath)) : '';
    const sourceWorld = worldPath || path.join(instanceRoot, '__minebot_new_world__');
    const templateCandidate = runtimeTemplate || resolveTemplate(config.server?.templatePath, [selectedRoot, instanceRoot], config.game);
    if (!templateCandidate) throw new Error('已找到游戏实例，但其中没有专用服务器启动文件。请选择包含 libraries 和 Forge win_args.txt 的本地服务端整合包；minebot不会把客户端 JAR 冒充服务端。');
    const template = path.resolve(templateCandidate);
    if (!instanceRoot || !fs.existsSync(instanceRoot)) throw new Error('游戏实例或整合包目录不存在，请重新选择。');
    const isInstanceWorld = worldPath && isInside(savesRoot, worldPath);
    const isWorkBuddyWorld = worldPath && samePath(worldPath, path.join(template, 'world'));
    const isPackWorld = worldPath && samePath(worldPath, path.join(instanceRoot, 'world'));
    if (worldPath && ((!isInstanceWorld && !isWorkBuddyWorld && !isPackWorld) || !fs.existsSync(path.join(worldPath, 'level.dat')))) {
      throw new Error('请先在“游戏与整合包”页面选择一个有效的世界存档。');
    }
    if (!worldPath && inspected?.worlds?.length) throw new Error('检测到已有世界，请先选择需要用于服务器的存档。');
    if (!launchArgs(template, { ...config.game, modLoader: config.game.modLoader || 'forge' })) {
      throw new Error('服务端启动文件与所选游戏版本或加载器不匹配。');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const buildsRoot = path.join(this.root, 'builds');
    await fs.promises.mkdir(buildsRoot, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(buildsRoot, `${stamp}-`));
    const excluded = new Set(['world', 'logs', 'crash-reports', 'backups', 'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts']);
    await fs.promises.cp(template, directory, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(template, source);
        if (!relative) return true;
        const first = relative.split(path.sep)[0];
        return !excluded.has(first) && !isSessionArtifact(first) && !['server_console.log', 'server-output.log'].includes(path.basename(source));
      }
    });
    const continuation = await selectWorld({ buildsRoot, instanceRoot, sourceWorld, worldPath, backupsRoot: path.join(this.root, 'recovery-backups'), onProgress: update => this.progress(update.message, 'recovery') });
    const worldSource = continuation.world;
    if (continuation.reason) this.progress(continuation.reason, 'recovery');
    this.state = { ...this.state, recovery: continuation.recovered ? { backupPath: continuation.backupPath, report: continuation.report } : null };
    if (worldSource) await fs.promises.cp(worldSource, path.join(directory, 'world'), { recursive: true, filter: file => path.basename(file) !== 'session.lock' });
    const excludedMods = [];
    const modsTarget = path.join(directory, 'mods');
    let manifestExcluded = new Set();
    try { manifestExcluded = new Set(JSON.parse(await fs.promises.readFile(path.join(selectedRoot, '.minebot-mrpack.json'), 'utf8')).serverExcluded.map(value => String(value).replaceAll('\\', '/').toLowerCase())); } catch {}
    for (const modsSource of [...new Set([path.join(template, 'mods'), path.join(instanceRoot, 'mods')])]) {
      if (!fs.existsSync(modsSource)) continue;
      await fs.promises.mkdir(modsTarget, { recursive: true });
      for (const entry of await fs.promises.readdir(modsSource, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
        const reason = (manifestExcluded.has(`mods/${entry.name}`.toLowerCase()) ? '整合包清单声明仅用于客户端' : '') || clientOnlyModReason(entry.name) || (String(config.game.modLoader).toLowerCase() === 'fabric' ? await fabricClientOnlyReason(path.join(modsSource, entry.name)) : '');
        if (reason) {
          excludedMods.push({ name: entry.name, reason });
          continue;
        }
        const destination = path.join(modsTarget, entry.name);
        if (!fs.existsSync(destination)) await fs.promises.copyFile(path.join(modsSource, entry.name), destination);
      }
    }
    for (const folder of ['config', 'defaultconfigs', 'kubejs', 'scripts']) {
      for (const source of [...new Set([path.join(instanceRoot, folder), path.join(template, folder)])]) {
        if (fs.existsSync(source)) await fs.promises.cp(source, path.join(directory, folder), { recursive: true, force: true });
      }
    }
    const serverOverrides = path.join(selectedRoot, 'server-overrides');
    if (fs.existsSync(serverOverrides)) {
      for (const entry of await fs.promises.readdir(serverOverrides, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || isSessionArtifact(entry.name) || ['world', 'logs', 'crash-reports', 'backups'].includes(entry.name.toLowerCase())) continue;
        await fs.promises.cp(path.join(serverOverrides, entry.name), path.join(directory, entry.name), { recursive: true, force: true });
      }
    }
    const installedMods = config.resources?.voiceEnabled ? await prepareVoiceMods({ game: config.game, instanceRoot, serverDirectory: directory, cacheRoot: path.join(this.root, 'managed-mods') }) : [];
    this.progress('正在检查服务端模组与必要依赖…', 'mods');
    const modPreparation = await prepareModDependencies(modsTarget, config.game, path.join(this.root, 'managed-mods'), update => this.progress(update.message, 'mods'));
    this.state = { ...this.state, modPreparation };
    await setPropertyOverride(
      path.join(directory, 'config', 'modernfix-mixins.properties'),
      'mixin.perf.smart_ingredient_sync',
      'false'
    );
    if (config.resources?.voiceEnabled) {
      const voiceConfig = path.join(directory, 'config', 'voicechat', 'voicechat-server.properties');
      await fs.promises.mkdir(path.dirname(voiceConfig), { recursive: true });
      if (!fs.existsSync(voiceConfig)) await fs.promises.writeFile(voiceConfig, '', { flag: 'wx' });
      await setPropertyOverride(voiceConfig, 'port', String(Number(config.network.voiceLocalPort) || 24454));
    }
    const jvmArgsPath = path.join(directory, 'user_jvm_args.txt');
    if (!fs.existsSync(jvmArgsPath)) {
      const available = Math.floor(os.freemem() / 1048576);
      if (available < 1300) throw new Error('当前可用内存不足以安全启动服务器。请先关闭不需要的程序，再点击重试；存档已保留。');
      const memory = Math.max(768, Math.min(4096, Math.floor((available - 512) / 256) * 256));
      await fs.promises.writeFile(jvmArgsPath, `-Xms512M\n-Xmx${memory}M\n`, 'utf8');
    }
    await fs.promises.writeFile(path.join(directory, 'eula.txt'), 'eula=true\n', 'utf8');
    const propertiesPath = path.join(directory, 'server.properties');
    const existing = fs.existsSync(propertiesPath) ? await fs.promises.readFile(propertiesPath, 'utf8') : '';
    const properties = updateProperties(existing, {
      'online-mode': 'false',
      'enforce-secure-profile': 'false',
      'server-ip': '',
      'level-name': 'world',
      'server-port': String(Number(config.network.gameLocalPort) || 25565),
      'query.port': String(Number(config.network.gameLocalPort) || 25565),
      'enable-rcon': 'false',
      'enable-status': 'true',
      'motd': `minebot · ${worldPath ? path.basename(worldPath) : '新世界'}`
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
    const worldLineage = await resolveWorldLineage(sourceWorld, worldSource, buildsRoot);
    await fs.promises.writeFile(path.join(directory, 'build-info.json'), `${JSON.stringify({ sourceInstance: instanceRoot, sourceWorld, worldLineage, parentWorld: !worldSource || samePath(worldSource, worldPath) ? '' : path.resolve(worldSource), template, excludedMods, installedMods, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    await writeJson(path.join(directory, '.minebot-world-baseline.json'), worldSource ? await worldManifest(path.join(directory, 'world')) : {});
    await recordSession(directory, { phase: 'prepared', everReady: false, pid: null });
    return { directory, worldPath, excludedMods, instanceRoot };
  }

  stop() {
    if (!this.child || this.child.exitCode !== null) return this.status();
    this.state = { ...this.state, phase: 'stopping', message: '正在保存世界并停止服务器…' };
    if (this.state.serverDirectory) this.journal(this.state.serverDirectory, { phase: 'stopping' }).catch(() => {});
    if (this.child.stdin?.writable) this.child.stdin.write('stop\n');
    return this.status();
  }

  async stopAndWait(timeoutMs = 90000) {
    if (this.startPromise) { try { await this.startPromise; } catch {} }
    if ((!this.child || this.child.exitCode !== null) && this.state.phase !== 'syncing') return this.status();
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

  async retrySync(config) {
    if (this.status().running || this.startPromise || this.state.phase === 'syncing') throw new Error('请等待服务器正常停止后再同步。');
    const directory = this.state.serverDirectory;
    if (!directory || !fs.existsSync(path.join(directory, '.minebot-clean-stop'))) throw new Error('尚未确认安全停服，不能直接同步；请使用自动恢复启动。');
    this.state = { ...this.state, phase: 'syncing', message: '正在重新校验并同步单人存档…' };
    try {
      const info = await readJson(path.join(directory, 'build-info.json'));
      const destination = info?.sourceInstance;
      if (typeof destination !== 'string' || !path.isAbsolute(destination) || !fs.existsSync(destination)) throw new Error('本次服务器对应的原游戏目录不存在或运行记录不完整。请恢复原目录后重试；不会写入当前新选的整合包。');
      const mirror = await this.exportDailyWorld(directory, destination);
      await this.lifecycle.onWorldExported?.(mirror.path, destination);
      this.state = { ...this.state, phase: 'stopped', syncFailed: false, mirrorPath: mirror.path, message: `存档已同步：${mirror.path}` };
      return this.status();
    } catch (error) { this.state = { ...this.state, phase: 'stopped', syncFailed: true, message: `存档同步失败，服务器世界仍完整保留：${error.message}` }; throw error; }
    finally { this.resolveStopWaiters(); }
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
    if (this.survivalBackupBusy) throw new Error('正在创建世界备份，请稍候。');
    if (!this.child || this.child.exitCode !== null || !this.state.ready) throw new Error('服务器尚未就绪，不能执行管理员施工。');
    const child = this.child;
    const validated = validateAdminCommands(commands);
    const world = path.join(this.state.serverDirectory, 'world');
    if (!fs.existsSync(path.join(world, 'level.dat'))) throw new Error('当前服务器世界不完整，已拒绝执行。');
    const backup = path.join(this.state.serverDirectory, 'backups', `admin-${formatLocalTimestamp(new Date())}`);
    this.survivalBackupBusy = true;
    child.stdin.write('save-off\n');
    try {
      const saved = waitForServerOutput(child, /Saved the game|Saved the world/i, 30000);
      child.stdin.write('save-all flush\n');
      await saved;
      await fs.promises.mkdir(path.dirname(backup), { recursive: true });
      await fs.promises.cp(world, backup, {
        recursive: true, errorOnExist: true, force: false,
        filter: (source) => path.relative(world, source).toLowerCase() !== 'session.lock'
      });
      if (!fs.existsSync(path.join(backup, 'level.dat'))) throw new Error('施工前备份校验失败。');
    } finally {
      if (child.stdin?.writable) child.stdin.write('save-on\n');
      this.survivalBackupBusy = false;
    }
    if (this.child !== child || child.exitCode !== null || !child.stdin?.writable) throw new Error('服务器已停止，备份保留，未执行施工命令。');
    for (const command of validated) child.stdin.write(`${command.replace(/^\//, '')}\n`);
    child.stdin.write('save-all flush\n');
    return { ok: true, commandCount: validated.length, backupPath: backup, message: `已提交 ${validated.length} 条建造命令；请检查服务器日志确认每条命令的结果。施工前备份已保存。` };
  }

  async backupForSurvivalBuild() {
    if (this.survivalBackupBusy) throw new Error('正在创建施工备份，请稍候。');
    if (!this.child || this.child.exitCode !== null || !this.state.ready || !this.child.stdin?.writable) throw new Error('服务器尚未就绪，不能备份施工世界。');
    this.survivalBackupBusy = true;
    const child = this.child;
    const world = path.join(this.state.serverDirectory, 'world');
    const backup = path.join(this.state.serverDirectory, 'backups', `survival-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      if (!fs.existsSync(path.join(world, 'level.dat'))) throw new Error('当前服务器世界不完整，已取消施工。');
      child.stdin.write('save-off\n');
      const saved = waitForServerOutput(child, /Saved the game|Saved the world/i, 30000);
      child.stdin.write('save-all flush\n');
      await saved;
      await fs.promises.mkdir(path.dirname(backup), { recursive: true });
      await fs.promises.cp(world, backup, { recursive: true, errorOnExist: true, force: false, filter: source => path.relative(world, source).toLowerCase() !== 'session.lock' });
      if (!fs.existsSync(path.join(backup, 'level.dat'))) throw new Error('施工前备份校验失败。');
      if (this.child !== child || child.exitCode !== null || !child.stdin?.writable) throw new Error('服务器已停止，备份保留，未开始施工。');
      return backup;
    } finally {
      if (child.stdin?.writable) child.stdin.write('save-on\n');
      this.survivalBackupBusy = false;
    }
  }

  isWorldContinuation(savedWorld) {
    if (!this.state.ready || !savedWorld) return false;
    let current = path.resolve(this.state.serverDirectory, 'world');
    const target = path.resolve(savedWorld);
    const builds = path.resolve(this.root, 'builds');
    const seen = new Set();
    for (let i = 0; i < 128; i++) {
      if (samePath(current, target)) return true;
      const dir = path.dirname(current), relative = path.relative(builds, dir);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 1 || seen.has(dir)) return false;
      seen.add(dir);
      let info;
      try { info = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8')); } catch { return false; }
      if (!info.parentWorld || path.basename(info.parentWorld) !== 'world') return false;
      const parent = path.resolve(info.parentWorld), parentDir = path.dirname(parent);
      const parentRelative = path.relative(builds, parentDir);
      if (!parentRelative || parentRelative.startsWith('..') || path.isAbsolute(parentRelative) || parentRelative.split(path.sep).length !== 1 || !fs.existsSync(path.join(parentDir, '.minebot-clean-stop'))) return false;
      current = parent;
    }
    return false;
  }

  async exportDailyWorld(serverDirectory, instancePath, now = new Date()) {
    const source = path.resolve(serverDirectory, 'world');
    const savesRoot = path.resolve(String(instancePath || ''), 'saves');
    if (!fs.existsSync(path.join(source, 'level.dat'))) throw new Error('服务器世界不完整，缺少 level.dat。');
    if (!fs.existsSync(savesRoot)) await fs.promises.mkdir(savesRoot, { recursive: true });
    const dateName = formatLocalDate(now);
    const baseName = `服务器存档-${dateName}`;
    let info = {};
    try { info = JSON.parse(await fs.promises.readFile(path.join(serverDirectory, 'build-info.json'), 'utf8')); } catch {}
    const lineage = String(info.worldLineage || '') || crypto.createHash('sha256').update(path.resolve(String(info.sourceWorld || source)).toLowerCase()).digest('hex');
    let targetName = baseName;
    let target = path.join(savesRoot, targetName);
    for (let suffix = 2; fs.existsSync(target); suffix++) {
      let marker;
      try { marker = JSON.parse(await fs.promises.readFile(path.join(target, '.minebot-export.json'), 'utf8')); } catch {}
      if (marker?.lineage === lineage) break;
      targetName = `${baseName}-${suffix}`;
      target = path.join(savesRoot, targetName);
    }
    const transactionFile = path.join(serverDirectory, '.minebot-sync.json');
    const pending = await readJson(transactionFile);
    // Finish rollback of an interrupted directory swap before starting again.
    if (pending?.target && pending?.previous && samePath(path.dirname(pending.target), savesRoot) && samePath(path.dirname(pending.previous), savesRoot)
      && path.basename(pending.previous).startsWith(`.${path.basename(pending.target)}.previous-`) && !fs.existsSync(pending.target) && fs.existsSync(pending.previous)) {
      await fs.promises.rename(pending.previous, pending.target);
    }
    const stamp = `${formatLocalTimestamp(now)}-${crypto.randomBytes(4).toString('hex')}`;
    const stage = path.join(savesRoot, `.${targetName}.sync-${stamp}`);
    const previous = path.join(savesRoot, `.${targetName}.previous-${stamp}`);
    await fs.promises.cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    if (!fs.existsSync(path.join(stage, 'level.dat'))) throw new Error('单人存档临时副本校验失败。');
    const [sourceFiles, copiedFiles] = await Promise.all([worldManifest(source), worldManifest(stage)]);
    if (!manifestsEqual(sourceFiles, copiedFiles)) throw new Error(`单人存档复制校验失败，已保留服务器世界和临时副本 ${stage}。`);
    await fs.promises.writeFile(path.join(stage, '.minebot-export.json'), JSON.stringify({ lineage }), 'utf8');
    await renameWorldDisplayName(path.join(stage, 'level.dat'), targetName);
    let previousPath = '';
    try {
      await writeJson(transactionFile, { phase: 'swapping', target, previous, stage });
      if (fs.existsSync(target)) {
        await fs.promises.rename(target, previous);
        previousPath = previous;
      }
      await fs.promises.rename(stage, target);
      await writeJson(transactionFile, { phase: 'complete', target, previous: previousPath, stage, completedAt: new Date().toISOString() });
      // The new target was copied, manifest-checked and atomically swapped.  A
      // previous same-lineage daily export is now redundant; remove only this
      // generated rollback, never another user world.
      if (previousPath) {
        try {
          await fs.promises.rm(previousPath, { recursive: true, force: true });
          previousPath = '';
          await writeJson(transactionFile, { phase: 'complete', target, previous: '', stage, completedAt: new Date().toISOString() });
        } catch { /* Keep the hidden rollback for recovery if Windows still holds a file. */ }
      }
    } catch (error) {
      if (!fs.existsSync(target) && previousPath && fs.existsSync(previousPath)) {
        await fs.promises.rename(previousPath, target).catch(() => {});
      }
      throw error;
    }
    return { path: target };
  }
}

async function resolveWorldLineage(sourceWorld, worldSource, buildsRoot) {
  for (const candidate of [sourceWorld, worldSource]) {
    if (!candidate) continue;
    const marker = await readJson(path.join(candidate, '.minebot-export.json'));
    if (typeof marker?.lineage === 'string' && /^[a-f0-9]{64}$/i.test(marker.lineage)) return marker.lineage.toLowerCase();
    const parent = path.dirname(path.resolve(candidate));
    const relative = path.relative(buildsRoot, parent);
    if (path.basename(candidate) === 'world' && relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep).length === 1) {
      const info = await readJson(path.join(parent, 'build-info.json'));
      if (typeof info?.worldLineage === 'string' && /^[a-f0-9]{64}$/i.test(info.worldLineage)) return info.worldLineage.toLowerCase();
    }
  }
  return crypto.createHash('sha256').update(path.resolve(String(sourceWorld)).toLowerCase()).digest('hex');
}

function waitForServerOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const streams = [child.stdout, child.stderr].filter(Boolean);
    const cleanup = () => { clearTimeout(timer); for (const stream of streams) stream.removeListener('data', onData); child.removeListener('exit', onExit); };
    const onData = (chunk) => { buffer = (buffer + String(chunk)).slice(-16000); if (pattern.test(buffer)) { cleanup(); resolve(); } };
    const onExit = () => { cleanup(); reject(new Error('等待服务器保存时服务器已退出，已取消施工。')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('服务器未确认保存完成，已取消施工；请查看日志。')); }, timeoutMs);
    for (const stream of streams) stream.on('data', onData);
    child.once('exit', onExit);
  });
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

function findWinArgs(directory, game = {}) {
  const forgeRoot = path.join(directory, 'libraries', 'net', 'minecraftforge', 'forge');
  if (!fs.existsSync(forgeRoot)) return '';
  for (const version of fs.readdirSync(forgeRoot)) {
    const mc = String(game.minecraftVersion || '').trim();
    const loader = String(game.loaderVersion || '').trim().replace(/^forge-/i, '').replace(mc ? new RegExp(`^${mc.replace(/\./g, '\\.')}[-_]`) : /^$/, '');
    if (mc && !version.startsWith(`${mc}-`)) continue;
    if (loader && version !== `${mc}-${loader}` && version !== loader) continue;
    const candidate = path.join(forgeRoot, version, 'win_args.txt');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function resolveTemplate(configured = '', localCandidates = [], game = {}) {
  // An explicit selection must never silently fall back to a different pack.
  if (configured) return launchArgs(configured, { ...game, modLoader: game.modLoader || 'forge' }) ? configured : '';
  const local = [configured, ...localCandidates, ...localCandidates.map((candidate) => path.dirname(candidate))]
    .filter(Boolean)
    .find((candidate) => Boolean(launchArgs(candidate, { ...game, modLoader: game.modLoader || 'forge' })));
  if (local) return local;
  const bundled = [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'server-template'),
    path.join(__dirname, '..', '..', 'runtime', 'server-template')
  ].filter(Boolean).find((candidate) => Boolean(findWinArgs(candidate, game)));
  const canUseBundled = String(game.minecraftVersion || SUPPORTED_RUNTIME.minecraftVersion) === SUPPORTED_RUNTIME.minecraftVersion
    && String(game.modLoader || SUPPORTED_RUNTIME.modLoader).toLowerCase() === SUPPORTED_RUNTIME.modLoader;
  return canUseBundled ? (bundled || '') : '';
}

function clientOnlyModReason(filename) {
  const normalized = String(filename || '').toLowerCase();
  const fragment = CLIENT_ONLY_MOD_FRAGMENTS.find((candidate) => normalized.includes(candidate));
  return fragment ? `专用服务器不兼容规则：${fragment}` : '';
}

function fabricClientOnlyReason(file) {
  return new Promise(resolve => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return resolve('');
      let finished = false;
      const done = value => { if (finished) return; finished = true; try { zip.close(); } catch {} resolve(value); };
      zip.on('error', () => done('')); zip.on('end', () => done(''));
      zip.on('entry', entry => {
        if (entry.fileName !== 'fabric.mod.json' || entry.uncompressedSize > 1024 * 1024) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return done('');
          const chunks = []; stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', () => done(''));
          stream.on('end', () => { try { const meta = JSON.parse(Buffer.concat(chunks).toString('utf8')); done(meta.environment === 'client' ? `模组 ${meta.id || ''} 声明仅供客户端使用` : ''); } catch { done(''); } });
        });
      });
      zip.readEntry();
    });
  });
}

async function setPropertyOverride(target, key, value) {
  if (!fs.existsSync(target)) return false;
  const source = await fs.promises.readFile(target, 'utf8');
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
  const line = `${key}=${value}`;
  const updated = matcher.test(source) ? source.replace(matcher, line) : `${source.trimEnd()}\n${line}\n`;
  await fs.promises.writeFile(target, updated, 'utf8');
  return true;
}

function updateProperties(source, changes) {
  const seen = new Set();
  const lines = String(source || '').split(/\r?\n/).map((line) => {
    const match = /^\s*([^#!\s=:]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!match || !Object.hasOwn(changes, match[1])) return line;
    if (seen.has(match[1])) return '';
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
  if (!['forge', 'fabric', 'neoforge', 'vanilla'].includes(modLoader)) {
    return {
      ok: false,
      detail: `已识别 Minecraft ${minecraftVersion} + ${modLoader}，当前尚未支持此加载器的自动配置。`
    };
  }
  if (modLoader !== 'vanilla' && !String(game.loaderVersion || '').trim()) return { ok: true, pending: true, detail: '尚未指定加载器版本，准备时将查询官方兼容版本；已有版本时会优先使用原包选择。' };
  return { ok: true, detail: `将按所选版本准备 Minecraft ${minecraftVersion} + ${modLoader} ${game.loaderVersion || ''}` };
}

function expectedJavaMajor(minecraftVersion) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(minecraftVersion || ''));
  if (!match) return 0;
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  if (Number(match[1]) >= 26) return 25;
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function selectJavaRuntime(scan = {}, game = {}) {
  const expectedMajor = Number(game.javaMajor) || expectedJavaMajor(game.minecraftVersion);
  const candidates = Array.isArray(scan.javaCandidates) ? scan.javaCandidates : [];
  const selected = candidates.find((candidate) => candidate.major === expectedMajor)
    || (scan.javaPath && scan.javaMajor === expectedMajor ? { path: scan.javaPath, version: scan.java, major: scan.javaMajor, source: scan.javaSource } : null);
  return { expectedMajor, selected, candidates };
}

function diagnoseServerOutput(text) {
  const source = String(text || '');
  if (/OutOfMemoryError|Could not reserve enough space/i.test(source)) return '服务器内存不足。请关闭占用内存的程序，或降低 user_jvm_args.txt 中的最大内存。';
  if (/UnsupportedClassVersionError|class file version/i.test(source)) return 'Java 版本不匹配。请重新确认当前 Minecraft 与加载器版本，再运行自动准备；部分模组还可能要求更高版本的 Java。';
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
