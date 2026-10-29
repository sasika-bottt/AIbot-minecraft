const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function exists(candidate) {
  try { return fs.existsSync(candidate); } catch { return false; }
}

function parseVersionMetadata(versionDir, name) {
  const jsonPath = path.join(versionDir, `${name}.json`);
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
  const libraries = Array.isArray(manifest.libraries)
    ? manifest.libraries.map((item) => String(item?.name || '')).join(' ').toLowerCase()
    : '';
  const combined = `${name} ${manifest.id || ''} ${libraries}`.toLowerCase();
  const modLoader = combined.includes('neoforge') ? 'neoforge'
    : combined.includes('fabric-loader') || combined.includes('fabricmc') ? 'fabric'
      : combined.includes('forge') ? 'forge' : 'vanilla';
  const inherited = String(manifest.inheritsFrom || manifest.clientVersion || '').trim();
  const versionMatch = (inherited || name).match(/\b(1\.\d+(?:\.\d+)?)\b/);
  const loaderLibrary = Array.isArray(manifest.libraries)
    ? manifest.libraries.map((item) => String(item?.name || '')).find((value) => /^(?:net\.minecraftforge:(?:forge|fmlloader)|net\.neoforged:neoforge|net\.fabricmc:fabric-loader):/i.test(value)) || ''
    : '';
  const loaderVersion = loaderLibrary.split(':').pop() || '';
  return {
    minecraftVersion: versionMatch?.[1] || inherited || '',
    modLoader,
    loaderVersion,
    javaMajor: Number(manifest.javaVersion?.majorVersion) || expectedJavaMajor(versionMatch?.[1] || inherited || ''),
    jsonPath: exists(jsonPath) ? jsonPath : ''
  };
}

function parsePackMetadata(directory) {
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { return null; }
  };
  const curse = read('manifest.json');
  if (curse?.minecraft?.version) {
    const loaderId = String(curse.minecraft.modLoaders?.find((item) => item?.primary)?.id || curse.minecraft.modLoaders?.[0]?.id || '');
    const match = /^(forge|neoforge|fabric)-(.+)$/i.exec(loaderId);
    return { minecraftVersion: String(curse.minecraft.version), modLoader: match?.[1]?.toLowerCase() || 'vanilla', loaderVersion: match?.[2] || '' };
  }
  const modrinth = read('modrinth.index.json');
  if (modrinth?.dependencies?.minecraft) {
    const loader = ['forge', 'neoforge', 'fabric-loader'].find((key) => modrinth.dependencies[key]);
    return { minecraftVersion: String(modrinth.dependencies.minecraft), modLoader: loader === 'fabric-loader' ? 'fabric' : (loader || 'vanilla'), loaderVersion: loader ? String(modrinth.dependencies[loader]) : '' };
  }
  const instance = read('minecraftinstance.json');
  if (instance) {
    const minecraftVersion = String(instance.gameVersion || instance.baseModLoader?.MinecraftVersion || '');
    const forge = String(instance.baseModLoader?.ForgeVersion || instance.baseModLoader?.Name || '');
    if (minecraftVersion || forge) return { minecraftVersion, modLoader: forge ? 'forge' : 'vanilla', loaderVersion: forge };
  }
  return null;
}

function versionsDirectory(root) {
  return [
    path.join(root, '.minecraft', 'versions'),
    path.join(root, 'versions')
  ].find(exists) || '';
}

function listMinecraftVersions(root) {
  const versionRoot = versionsDirectory(root);
  if (!versionRoot) return [];
  try {
    return fs.readdirSync(versionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(versionRoot, entry.name);
        const metadata = parseVersionMetadata(dir, entry.name);
        return {
          name: entry.name,
          path: dir,
          ...metadata,
          hasJar: exists(path.join(dir, `${entry.name}.jar`)),
          hasMods: exists(path.join(dir, 'mods')),
          hasSaves: exists(path.join(dir, 'saves'))
        };
      })
      .filter((entry) => entry.jsonPath || entry.hasJar || entry.hasMods);
  } catch {
    return [];
  }
}

function pcl2Candidates() {
  const home = process.env.USERPROFILE || '';
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = [
    roaming,
    path.join(home, 'Desktop', 'PCL'),
    path.join(home, 'Desktop', 'PCL2'),
    'D:\\PCL', 'D:\\PCL2', 'D:\\我的世界',
    'E:\\PCL', 'E:\\PCL2', 'E:\\我的世界',
    'F:\\PCL', 'F:\\PCL2', 'F:\\我的世界'
  ];
  // Discover launcher folders without embedding any developer-specific path.
  // Limit scanning to one directory level on local drive roots.
  for (const drive of ['C:\\', 'D:\\', 'E:\\', 'F:\\']) {
    try {
      for (const entry of fs.readdirSync(drive, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(drive, entry.name);
        if (exists(path.join(candidate, '.minecraft', 'versions')) || exists(path.join(candidate, 'PCL2.exe')) || exists(path.join(candidate, 'Plain Craft Launcher 2.exe'))) roots.push(candidate);
      }
    } catch { /* Drives and individual directories can be unavailable. */ }
  }
  const seen = new Set();
  const results = [];
  for (const root of roots) {
    const key = root.toLowerCase();
    if (seen.has(key) || !exists(root)) continue;
    seen.add(key);
    const versions = listMinecraftVersions(root);
    const pclExe = ['Plain Craft Launcher 2.exe', 'PCL2.exe']
      .map((name) => path.join(root, name)).find(exists) || '';
    if (versions.length || pclExe) results.push({ root, pclExe, versions });
  }
  return results;
}

async function commandVersion(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000, windowsHide: true });
    return `${stdout || ''}${stderr || ''}`.trim().split(/\r?\n/)[0];
  } catch {
    return '';
  }
}

function javaMajor(versionText) {
  const match = String(versionText || '').match(/version\s+"(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : 0;
}

async function pathJavaCandidates() {
  try {
    const { stdout } = await execFileAsync('where.exe', ['java.exe'], { timeout: 5000, windowsHide: true });
    return String(stdout || '').split(/\r?\n/).map((value) => value.trim()).filter((value) => value && exists(value));
  } catch {
    return [];
  }
}

function javaCandidates(launchers) {
  const roots = [
    process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft', 'runtime'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium'),
    ...launchers.flatMap((launcher) => [path.join(launcher.root, '.minecraft', 'runtime'), path.join(launcher.root, 'runtime')])
  ].filter(Boolean);
  const found = [];
  for (const root of roots) collectJavaExecutables(root, 4, found);
  return [...new Set(found.map((candidate) => path.resolve(candidate)))];
}

function collectJavaExecutables(directory, depth, found) {
  if (depth < 0 || !exists(directory)) return;
  const direct = path.join(directory, 'bin', 'java.exe');
  if (exists(direct)) found.push(direct);
  if (depth === 0) return;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) collectJavaExecutables(path.join(directory, entry.name), depth - 1, found);
    }
  } catch {}
}

async function detectJava(launchers) {
  const pathCandidates = await pathJavaCandidates();
  const candidates = [
    ...pathCandidates.map((candidate) => ({ path: candidate, source: 'PATH' })),
    ...javaCandidates(launchers).map((candidate) => ({ path: candidate, source: 'Minecraft/PCL 运行时' }))
  ].filter((candidate, index, all) => all.findIndex((item) => item.path.toLowerCase() === candidate.path.toLowerCase()) === index);
  const detected = [];
  for (const candidate of candidates) {
    const version = await commandVersion(candidate.path, ['-version']);
    if (version) detected.push({ version, path: candidate.path, source: candidate.source, major: javaMajor(version) });
  }
  if (!detected.length) {
    const fallback = await commandVersion('java', ['-version']);
    if (fallback) detected.push({ version: fallback, path: 'java', source: 'PATH', major: javaMajor(fallback) });
  }
  if (detected.length) return { ...detected[0], compatible: true, candidates: detected };
  return { version: '', path: '', source: '', major: 0, compatible: false, candidates: [] };
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

function selectJavaForVersion(candidates, minecraftVersion, declaredMajor = 0) {
  const expected = expectedJavaMajor(minecraftVersion) || Number(declaredMajor);
  const list = Array.isArray(candidates) ? candidates : [];
  const selected = list.find((candidate) => candidate.major === expected) || null;
  return { expectedMajor: expected, selected, candidates: list };
}

function resolveContentRoot(instancePath) {
  const selected = path.resolve(String(instancePath || ''));
  const candidates = [selected];
  if (path.basename(path.dirname(selected)).toLowerCase() === 'versions') candidates.push(path.dirname(path.dirname(selected)));
  for (const name of ['overrides', 'minecraft', '.minecraft']) {
    const candidate = path.join(selected, name);
    if (exists(candidate)) candidates.push(candidate);
  }
  let best = selected;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = Number(exists(path.join(candidate, 'saves'))) * 8
      + Number(exists(path.join(candidate, 'mods'))) * 6
      + Number(exists(path.join(candidate, 'config'))) * 3
      + Number(exists(path.join(candidate, 'options.txt')));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

async function systemScan() {
  const launchers = pcl2Candidates();
  const java = await detectJava(launchers);
  return {
    java: java.version,
    javaPath: java.path,
    javaSource: java.source,
    javaMajor: java.major,
    javaCompatible: java.compatible,
    javaCandidates: java.candidates,
    node: process.version,
    launchers
  };
}

function inspectWorld(worldPath, name = path.basename(worldPath)) {
  const levelPath = path.join(worldPath, 'level.dat');
  if (!exists(levelPath)) return null;
  const stat = fs.statSync(levelPath);
  return { name, path: worldPath, lastPlayedAt: stat.mtime.toISOString(), source: 'workbuddy' };
}

function inspectInstance(instancePath) {
  if (!instancePath || !exists(instancePath)) return { exists: false, mods: [], voiceMods: [], worlds: [] };
  const contentRoot = resolveContentRoot(instancePath);
  const versionMetadata = parseVersionMetadata(instancePath, path.basename(instancePath));
  const packMetadata = parsePackMetadata(instancePath) || parsePackMetadata(contentRoot);
  const metadata = packMetadata || versionMetadata;
  const modsDir = path.join(contentRoot, 'mods');
  const mods = exists(modsDir)
    ? fs.readdirSync(modsDir).filter((name) => name.toLowerCase().endsWith('.jar'))
    : [];
  const voiceMods = mods.filter((name) => /voicechat|simple.?voice/i.test(name));
  const savesDir = path.join(contentRoot, 'saves');
  const worlds = exists(savesDir)
    ? fs.readdirSync(savesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
      const worldPath = path.join(savesDir, entry.name);
      return inspectWorld(worldPath, entry.name);
    }).filter(Boolean).sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt))
    : [];
  const directWorld = inspectWorld(path.join(contentRoot, 'world'), 'world');
  if (directWorld && !worlds.some((world) => world.path === directWorld.path)) worlds.unshift(directWorld);
  return {
    exists: true,
    path: instancePath,
    contentRoot,
    minecraftVersion: metadata.minecraftVersion,
    modLoader: metadata.modLoader,
    loaderVersion: metadata.loaderVersion,
    javaMajor: metadata.javaMajor || expectedJavaMajor(metadata.minecraftVersion),
    versionJson: metadata.jsonPath,
    modsDir,
    mods,
    voiceMods,
    worlds,
    hasOptions: exists(path.join(contentRoot, 'options.txt')),
    hasSaves: exists(path.join(contentRoot, 'saves'))
  };
}

module.exports = { systemScan, inspectInstance, parseVersionMetadata, parsePackMetadata, resolveContentRoot, javaMajor, expectedJavaMajor, selectJavaForVersion, detectJava };
