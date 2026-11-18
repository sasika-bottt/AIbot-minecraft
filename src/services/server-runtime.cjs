const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const yauzl = require('yauzl');
const { listZip, extractZipSafely } = require('./archive-manager.cjs');
const { downloadFile, fetchJson, fetchText, withRetry } = require('./downloads.cjs');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC = 'https://meta.fabricmc.net/v2';

function safeVersion(value, name) {
  const version = String(value || '').trim();
  if (!version || version.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) || version.includes('..')) throw new Error(`无法确定有效的${name}，请重新选择游戏实例。`);
  return version;
}

async function getJson(url) {
  const hostname = new URL(url).hostname;
  if (!['piston-meta.mojang.com', 'meta.fabricmc.net', 'api.adoptium.net', 'files.minecraftforge.net'].includes(hostname)) throw new Error('版本信息不属于受信任的官方来源。');
  return fetchJson(url, hostname);
}

async function download(url, target, expectedHash = '', algorithm = 'sha1') {
  const parsed = new URL(url);
  const isJavaArchive = parsed.hostname === 'github.com' && /^\/adoptium\/temurin\d+-binaries\/releases\/download\//.test(parsed.pathname);
  if (parsed.protocol !== 'https:' || (!isJavaArchive && !['meta.fabricmc.net', 'piston-data.mojang.com', 'maven.minecraftforge.net', 'maven.neoforged.net'].includes(parsed.hostname))) throw new Error('下载地址不属于受信任的官方来源。');
  return (await downloadFile(url, target, { algorithm, hash: expectedHash, minBytes: 1024, hosts: ['meta.fabricmc.net', 'piston-data.mojang.com', 'maven.minecraftforge.net', 'maven.neoforged.net', ...(isJavaArchive ? ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] : [])] })).hash;
}

async function ensureJava(root, major) {
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new Error('无法确定需要的 Java 版本。');
  const final = path.join(root, `java-${major}`);
  const markerFile = path.join(final, '.minebot-java.json');
  if (fs.existsSync(final)) {
    try {
      const marker = JSON.parse(await fs.promises.readFile(markerFile, 'utf8'));
      if (!marker.path || path.isAbsolute(marker.path) || marker.path.split(/[\\/]/).includes('..')) throw new Error();
      const executable = path.join(final, marker.path);
      const hash = crypto.createHash('sha256').update(await fs.promises.readFile(executable)).digest('hex');
      if (marker.major === major && hash === marker.sha256) return executable;
    } catch {}
    await fs.promises.rename(final, `${final}.preserved-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  }
  await fs.promises.mkdir(root, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(root, `.java-${major}-`));
  try {
    const assets = await getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`);
    const pkg = assets?.[0]?.binary?.package;
    if (!pkg || !/^[0-9a-f]{64}$/i.test(pkg.checksum || '') || !String(pkg.name).endsWith('.zip')) throw new Error(`官方未提供可自动安装的 Java ${major} Windows 运行环境。`);
    const archive = path.join(stage, 'java.zip');
    await download(pkg.link, archive, pkg.checksum, 'sha256');
    await listZip(archive);
    const unpacked = path.join(stage, 'runtime'); await fs.promises.mkdir(unpacked);
    await extractZipSafely(archive, unpacked);
    const dirs = await fs.promises.readdir(unpacked, { withFileTypes: true });
    const candidate = dirs.filter(entry => entry.isDirectory()).map(entry => path.join(unpacked, entry.name, 'bin', 'java.exe')).find(fs.existsSync);
    if (!candidate) throw new Error('Java 压缩包中缺少运行程序。');
    const version = await new Promise((resolve, reject) => {
      const child = spawn(candidate, ['-version'], { windowsHide: true }); let output = '';
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Java 校验超时。')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('Java 校验失败。')); });
    });
    const actualMajor = Number(/version\s+"(?:1\.)?(\d+)/i.exec(version)?.[1] || 0);
    if (actualMajor !== major) throw new Error(`下载的 Java 版本不匹配，期望 ${major}。`);
    const rel = path.relative(stage, candidate);
    const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(candidate)).digest('hex');
    await fs.promises.writeFile(path.join(stage, '.minebot-java.json'), JSON.stringify({ major, path: rel, sha256 }, null, 2));
    await fs.promises.unlink(archive);
    await fs.promises.rename(stage, final);
    return path.join(final, rel);
  } catch (error) { throw new Error(`自动准备 Java ${major} 失败：${error.message || error}。诊断目录：${stage}`); }
}

function runtimeMarker(directory, game) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, '.minebot-runtime.json'), 'utf8'));
    if (marker.minecraftVersion !== game.minecraftVersion || marker.modLoader !== game.modLoader || marker.loaderVersion !== game.loaderVersion) return false;
    return (marker.files || []).every(item => {
      if (!item.path || item.path.includes('..') || path.isAbsolute(item.path)) return false;
      const target = path.join(directory, item.path);
      return fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === item.sha256;
    }) && marker.files?.length > 0;
  } catch { return false; }
}

function launchArgs(directory, game = {}) {
  const loader = String(game.modLoader || '').toLowerCase();
  if (loader === 'fabric') {
    try {
      const launch = JSON.parse(fs.readFileSync(path.join(directory, '.minebot-fabric.json'), 'utf8'));
      if (launch.minecraftVersion !== game.minecraftVersion || launch.loaderVersion !== game.loaderVersion || launch.mainClass !== 'net.fabricmc.loader.impl.launch.knot.KnotServer' || !Array.isArray(launch.libraries) || !launch.libraries.length) return null;
      if (!launch.libraries.every(file => /^libraries\/[A-Za-z0-9_./+\-]+\.jar$/.test(file) && !file.includes('..') && fs.existsSync(path.join(directory, file)))) return null;
      return [...memoryArgs(directory), '-Dfabric.gameJarPath=server.jar', '-cp', [...launch.libraries, 'server.jar'].join(path.delimiter), launch.mainClass, 'nogui'];
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    return fs.existsSync(path.join(directory, 'fabric-server-launch.jar')) ? ['-Dfabric.installer.server.gameJar=server.jar', '-jar', 'fabric-server-launch.jar', 'nogui'] : null;
  }
  if (loader === 'vanilla') return fs.existsSync(path.join(directory, 'server.jar')) ? [...memoryArgs(directory), '-jar', 'server.jar', 'nogui'] : null;
  const namespace = loader === 'neoforge' ? 'neoforged' : 'minecraftforge';
  const type = loader === 'neoforge' ? 'neoforge' : 'forge';
  const root = path.join(directory, 'libraries', 'net', namespace, type);
  const mc = String(game.minecraftVersion || '');
  const raw = String(game.loaderVersion || '').replace(/^forge-/i, '');
  const loaderVersion = raw.startsWith(`${mc}-`) ? raw.slice(mc.length + 1) : raw;
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter(v => loader === 'neoforge' ? (!loaderVersion || v === loaderVersion) : (!mc || v.startsWith(`${mc}-`)) && (!loaderVersion || v === `${mc}-${loaderVersion}`)) : [];
  for (const version of versions) {
    const relative = path.join('libraries', 'net', namespace, type, version, 'win_args.txt');
    if (fs.existsSync(path.join(directory, relative))) return ['@user_jvm_args.txt', `@${relative.replaceAll('\\', '/')}`, 'nogui'];
  }
  if (loader === 'forge' && mc && loaderVersion) {
    for (const name of [`forge-${mc}-${loaderVersion}.jar`, `forge-${mc}-${loaderVersion}-universal.jar`]) {
      if (fs.existsSync(path.join(directory, name))) return [...memoryArgs(directory), '-jar', name, 'nogui'];
    }
  }
  return null;
}

function memoryArgs(directory) {
  try { const text = fs.readFileSync(path.join(directory, 'user_jvm_args.txt'), 'utf8'); const args = text.split(/\r?\n/).map(line => line.split('#')[0]).join(' ').split(/\s+/).filter(token => /^-Xm[sx]\d+[mMgG]$/.test(token)); if (args.length) return args; } catch {}
  return ['-Xms512M', '-Xmx4G'];
}

function readZipEntry(file, name) {
  return new Promise(resolve => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return resolve('');
      let finished = false;
      const done = value => { if (finished) return; finished = true; try { zip.close(); } catch {} resolve(value); };
      zip.on('error', () => done('')); zip.on('end', () => done(''));
      zip.on('entry', entry => {
        if (entry.fileName !== name || entry.uncompressedSize > 1024 * 1024) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return done('');
          const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', () => done(''));
          stream.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        });
      });
      zip.readEntry();
    });
  });
}

async function isTemplateCompatible(directory, game) {
  if (!directory || !launchArgs(directory, game)) return false;
  if (game.modLoader !== 'fabric' && game.modLoader !== 'vanilla') return true;
  try {
    const version = JSON.parse(await readZipEntry(path.join(directory, 'server.jar'), 'version.json'));
    if (version.id !== game.minecraftVersion) return false;
    if (game.modLoader === 'fabric') {
      const text = await readZipEntry(path.join(directory, 'fabric-server-launch.jar'), 'install.properties');
      const props = Object.fromEntries(text.split(/\r?\n/).map(line => line.split('=')).filter(parts => parts.length === 2));
      return props['game-version'] === game.minecraftVersion && props['fabric-loader-version'] === game.loaderVersion;
    }
    return true;
  } catch { return false; }
}

async function runInstaller(javaPath, installer, directory) {
  await new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', installer, '--installServer', directory], { cwd: directory, windowsHide: true });
    let output = '';
    const capture = chunk => { output = `${output}${chunk}`.slice(-12000); fs.appendFileSync(path.join(directory, 'minebot-installer.log'), chunk); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { child.kill(); reject(new Error('官方服务端安装超过 10 分钟，请检查网络后重试。')); }, 600000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const error = new Error(`官方服务端安装失败（${code}）：${output.slice(-1000)}`);
      error.retryable = /Connection reset|timed? out|UnknownHostException|SSLHandshakeException|Unable to download|Failed to download/i.test(output);
      reject(error);
    });
  });
}

async function ensureRuntime(cacheRoot, config, javaPath, onProgress = () => {}) {
  const game = { minecraftVersion: safeVersion(config.minecraftVersion, 'Minecraft 版本'), modLoader: String(config.modLoader || '').toLowerCase(), loaderVersion: String(config.loaderVersion || '') };
  if (!['fabric', 'forge', 'neoforge', 'vanilla'].includes(game.modLoader)) throw new Error(`暂无法自动准备 ${game.modLoader || '未知'} 加载器的服务端。`);
  if (game.modLoader !== 'vanilla') game.loaderVersion = safeVersion(game.loaderVersion, '模组加载器版本');
  const name = `${game.modLoader}-${game.minecraftVersion}-${game.loaderVersion || 'none'}`;
  const final = path.join(cacheRoot, name);
  if (runtimeMarker(final, game) && launchArgs(final, game) && (game.modLoader !== 'fabric' || fs.existsSync(path.join(final, '.minebot-fabric.json')))) return final;
  let previous = '';
  if (fs.existsSync(final)) {
    previous = `${final}.preserved-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    onProgress({ message: '发现旧版或不完整运行缓存，已保留并重新准备校验资源…' });
    await fs.promises.rename(final, previous);
  }
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(cacheRoot, `.${name}-`));
  try {
    const files = [];
    if (game.modLoader === 'fabric' || game.modLoader === 'vanilla') {
      const manifest = await getJson(MANIFEST);
      const entry = manifest.versions?.find(v => v.id === game.minecraftVersion);
      if (!entry || !/^https:\/\/piston-meta\.mojang\.com\//.test(entry.url)) throw new Error(`官方没有找到 Minecraft ${game.minecraftVersion} 的服务端版本信息。`);
      const version = await getJson(entry.url);
      if (version.id !== game.minecraftVersion || !version.downloads?.server?.sha1) throw new Error('官方服务端版本信息不完整。');
      let reused = false;
      if (previous && fs.existsSync(path.join(previous, 'server.jar'))) {
        const data = await fs.promises.readFile(path.join(previous, 'server.jar'));
        if (crypto.createHash('sha1').update(data).digest('hex') === version.downloads.server.sha1.toLowerCase()) { await fs.promises.copyFile(path.join(previous, 'server.jar'), path.join(stage, 'server.jar'), fs.constants.COPYFILE_EXCL); reused = true; }
      }
      if (!reused) await downloadFile(version.downloads.server.url, path.join(stage, 'server.jar'), { hosts: ['piston-data.mojang.com'], hash: version.downloads.server.sha1, algorithm: 'sha1', minBytes: 1024, onRetry: onProgress, onProgress: value => onProgress({ message: `正在下载 Minecraft 服务端：${Math.round(value.bytes / 1048576)} MB${value.total ? ` / ${Math.round(value.total / 1048576)} MB` : ''}…` }) });
      files.push('server.jar');
      if (game.modLoader === 'fabric') {
        const loader = await getJson(`${FABRIC}/versions/loader/${game.minecraftVersion}/${game.loaderVersion}/server/json`);
        if (loader.mainClass !== 'net.fabricmc.loader.impl.launch.knot.KnotServer' || !Array.isArray(loader.libraries) || loader.libraries.length < 2 || loader.libraries.length > 100) throw new Error('Fabric 官方启动信息不完整或不受支持。');
        const libraries = [];
        for (const lib of loader.libraries) {
          const parts = String(lib.name || '').split(':');
          if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_.+\-]+$/.test(x) || x.includes('..'))) throw new Error('Fabric 运行库名称无效。');
          const [group, artifact, version] = parts;
          const relative = `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
          const base = new URL(lib.url);
          if (base.protocol !== 'https:' || !['maven.fabricmc.net', 'libraries.minecraft.net'].includes(base.hostname) || base.username || base.password) throw new Error('Fabric 依赖来源不是允许的官方仓库。');
          const url = new URL(relative, base).href;
          const hash = lib.sha512 || lib.sha256 || lib.sha1 || (await fetchText(`${url}.sha1`, base.hostname, { maxBytes: 1024 })).trim().split(/\s+/)[0];
          const algorithm = lib.sha512 ? 'sha512' : lib.sha256 ? 'sha256' : 'sha1';
          if (!new RegExp(`^[a-f0-9]{${algorithm === 'sha512' ? 128 : algorithm === 'sha256' ? 64 : 40}}$`, 'i').test(hash)) throw new Error('Fabric 运行库缺少有效校验值。');
          const file = `libraries/${relative}`;
          await fs.promises.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
          onProgress({ message: `正在准备 Fabric 运行库 ${artifact}（${libraries.length + 1}/${loader.libraries.length}）…` });
          await downloadFile(url, path.join(stage, file), { hosts: [base.hostname], algorithm, hash, size: lib.size, maxBytes: 100 * 1024 * 1024, onRetry: onProgress });
          libraries.push(file); files.push(file);
        }
        await fs.promises.writeFile(path.join(stage, '.minebot-fabric.json'), JSON.stringify({ ...game, mainClass: loader.mainClass, libraries }, null, 2));
        files.push('.minebot-fabric.json');
        const installers = await getJson(`${FABRIC}/versions/installer`);
        const installer = installers.find(item => item.stable)?.version;
        safeVersion(installer, 'Fabric 安装器版本');
        await download(`${FABRIC}/versions/loader/${game.minecraftVersion}/${game.loaderVersion}/${installer}/server/jar`, path.join(stage, 'fabric-server-launch.jar'));
        files.push('fabric-server-launch.jar');
      }
    } else {
      const forgeVersion = game.loaderVersion.startsWith(`${game.minecraftVersion}-`) ? game.loaderVersion : `${game.minecraftVersion}-${game.loaderVersion}`;
      const version = game.modLoader === 'forge' ? forgeVersion : game.loaderVersion;
      const base = game.modLoader === 'forge' ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar` : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
      const sha = (await fetchText(`${base}.sha1`, new URL(base).hostname, { maxBytes: 1024, onRetry: onProgress })).trim().split(/\s+/)[0];
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('无法获取官方安装器校验值。');
      const installer = path.join(stage, 'installer.jar');
      await download(base, installer, sha);
      onProgress({ message: `正在执行 ${game.modLoader === 'forge' ? 'Forge' : 'NeoForge'} 官方安装器并准备运行库…` });
      await withRetry(() => runInstaller(javaPath, installer, stage), { retries: 1, onRetry: onProgress });
      const args = launchArgs(stage, game);
      if (!args) throw new Error('安装完成但未找到与所选版本匹配的服务端启动文件。');
      files.push(args[0] === '@user_jvm_args.txt' ? args[1].slice(1) : args[args.indexOf('-jar') + 1]);
      const collect = async folder => {
        for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
          const file = path.join(folder, entry.name);
          if (entry.isSymbolicLink()) throw new Error('安装器运行库中出现目录链接，停止缓存。');
          if (entry.isDirectory()) await collect(file);
          else if (entry.isFile()) files.push(path.relative(stage, file));
        }
      };
      if (fs.existsSync(path.join(stage, 'libraries'))) await collect(path.join(stage, 'libraries'));
      for (const entry of await fs.promises.readdir(stage, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.jar') && entry.name !== 'installer.jar') files.push(entry.name);
    }
    const checks = [...new Set(files)].map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, file))).digest('hex') }));
    await fs.promises.writeFile(path.join(stage, '.minebot-runtime.json'), JSON.stringify({ ...game, files: checks }, null, 2));
    await fs.promises.rename(stage, final);
    return final;
  } catch (error) {
    // Preserve a failed installer directory and its logs for diagnosis.
    throw new Error(`自动准备服务器失败：${error.message || error}。未修改原整合包；诊断目录：${stage}`);
  }
}

async function resolveLoaderVersion(game) {
  const mc = safeVersion(game.minecraftVersion, 'Minecraft 版本');
  if (game.modLoader === 'vanilla') return '';
  if (game.loaderVersion) return safeVersion(game.loaderVersion, '加载器版本');
  if (game.modLoader === 'fabric') {
    const versions = await getJson(`${FABRIC}/versions/loader/${mc}`);
    const match = Array.isArray(versions) && (versions.find(v => v.loader?.stable) || versions[0]);
    if (!match?.loader?.version) throw new Error(`官方未列出 Minecraft ${mc} 的 Fabric 加载器。请检查版本选择。`);
    return safeVersion(match.loader.version, 'Fabric 加载器版本');
  }
  if (game.modLoader === 'forge') {
    const data = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const version = data.promos?.[`${mc}-recommended`] || data.promos?.[`${mc}-latest`];
    if (!version) throw new Error(`Forge 官方没有 Minecraft ${mc} 的推荐或最新版本，无法替换成其他游戏版本。请选择已有对应加载器的整合包。`);
    return safeVersion(version, 'Forge 加载器版本');
  }
  if (game.modLoader === 'neoforge') {
    const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', 'maven.neoforged.net');
    const prefix = mc.startsWith('1.') ? mc.slice(2).split('.').slice(0, 2).join('.') : mc.split('.').slice(0, 2).join('.');
    const candidates = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => v.startsWith(`${prefix}.`) && /^\d+(?:\.\d+)+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!candidates.length) throw new Error(`NeoForge 官方未列出 Minecraft ${mc} 的稳定对应版本，请选择整合包使用的具体加载器版本。`);
    return safeVersion(candidates[0], 'NeoForge 加载器版本');
  }
  throw new Error('请选择原版、Fabric、Forge 或 NeoForge。');
}

module.exports = { ensureRuntime, ensureJava, runtimeMarker, launchArgs, safeVersion, isTemplateCompatible, resolveLoaderVersion };
