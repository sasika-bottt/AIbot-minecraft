const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const semver = require('semver');
const { fetchJson, downloadFile } = require('./downloads.cjs');

function parseMetadata(text) {
  // Fabric's Gson accepts unescaped newlines in descriptive strings. Parse
  // those without rewriting the user's jar or dropping the entire mod.
  let normal = '', quoted = false, escaped = false;
  for (const char of text) {
    if (quoted && !escaped && char.charCodeAt(0) < 32) { normal += JSON.stringify(char).slice(1, -1); continue; }
    normal += char;
    if (escaped) escaped = false;
    else if (char === '\\' && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return JSON.parse(normal);
}

async function metadataGraph(input, depth = 0, budget = { count: 0, bytes: 0 }) {
  if (depth > 4 || ++budget.count > 512) throw new Error('模组嵌套层级或数量过多，无法安全自动检查。');
  const zip = await new Promise((resolve, reject) => {
    const callback = (error, value) => error ? reject(error) : resolve(value);
    Buffer.isBuffer(input) ? yauzl.fromBuffer(input, { lazyEntries: true }, callback) : yauzl.open(input, { lazyEntries: true }, callback);
  }).catch(() => null);
  if (!zip) return [];
  let metadata = null;
  const nested = new Map();
  await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => {
      if (entry.fileName !== 'fabric.mod.json' && !entry.fileName.endsWith('.jar')) return zip.readEntry();
      if (entry.uncompressedSize > 40 * 1024 * 1024 || budget.bytes + entry.uncompressedSize > 160 * 1024 * 1024) { zip.close(); return reject(new Error('模组嵌套文件过大。')); }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = []; let bytes = 0;
        stream.on('data', chunk => { bytes += chunk.length; if (bytes > 40 * 1024 * 1024) stream.destroy(new Error('模组文件过大')); else chunks.push(chunk); });
        stream.on('error', reject);
        stream.on('end', () => {
          budget.bytes += bytes;
          try { const data = Buffer.concat(chunks); if (entry.fileName === 'fabric.mod.json') metadata = parseMetadata(data.toString('utf8')); else nested.set(entry.fileName, data); zip.readEntry(); }
          catch (error) { zip.close(); reject(error); }
        });
      });
    }); zip.readEntry();
  });
  if (!metadata) return [];
  const result = [metadata];
  for (const item of metadata.jars || []) {
    if (typeof item.file !== 'string' || !nested.has(item.file)) continue;
    result.push(...await metadataGraph(nested.get(item.file), depth + 1, budget));
  }
  return result;
}
function matches(version, range) {
  if (Array.isArray(range)) return range.some(value => matches(version, value));
  if (range === '*' || range == null) return true;
  const v = semver.valid(String(version)) || semver.coerce(String(version))?.version;
  const r = semver.validRange(String(range));
  // Unrecognised custom version strings are left to the official loader.
  return !v || !r ? true : semver.satisfies(v, r, { includePrerelease: true });
}
async function inspectMods(directory, game) {
  const installed = new Map([['minecraft', { version: game.minecraftVersion }], ['java', { version: String(game.javaMajor || 21) }], ['fabricloader', { version: game.loaderVersion }]]);
  const roots = [];
  if (!fs.existsSync(directory)) return { installed, roots, missing: [], conflicts: [], duplicates: [] };
  const duplicates = [], conflicts = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
    const file = path.join(directory, entry.name), graph = (await metadataGraph(file)).filter(metadata => metadata.environment !== 'client');
    if (!graph.length || typeof graph[0].id !== 'string') continue;
    const sha512 = crypto.createHash('sha512').update(await fs.promises.readFile(file)).digest('hex');
    const root = { file, sha512, graph, metadata: graph[0] };
    const duplicate = roots.find(value => value.metadata.id === root.metadata.id);
    if (duplicate) {
      if (duplicate.sha512 === sha512) duplicates.push(file);
      else conflicts.push(`模组 ${root.metadata.id} 有两个不同文件：${path.basename(duplicate.file)}、${entry.name}。需要选择保留的版本。`);
      continue;
    }
    roots.push(root);
    for (const metadata of graph) for (const id of [metadata.id, ...(metadata.provides || [])]) {
      if (typeof id !== 'string') continue;
      const current = installed.get(id);
      if (!current || semver.gt(semver.coerce(String(metadata.version))?.version || '0.0.0', semver.coerce(String(current.version))?.version || '0.0.0')) installed.set(id, { version: metadata.version, root });
    }
  }
  const missing = [];
  for (const root of roots) for (const metadata of root.graph) {
    for (const [id, range] of Object.entries(metadata.depends || {})) {
      const dependency = installed.get(id);
      if (!dependency) missing.push({ id, range, parent: metadata.id, root });
      else if (!matches(dependency.version, range)) conflicts.push(`${metadata.id} 需要 ${id} ${JSON.stringify(range)}，当前为 ${dependency.version}。不会自动替换已有内容模组。`);
    }
    for (const [id, range] of Object.entries(metadata.breaks || {})) if (installed.has(id) && matches(installed.get(id).version, range)) conflicts.push(`${metadata.id} 与 ${id} ${installed.get(id).version} 冲突，需要选择兼容版本。`);
  }
  return { installed, roots, missing, conflicts, duplicates };
}
async function prepareModDependencies(directory, game, cacheRoot, onProgress = () => {}) {
  if (game.modLoader !== 'fabric') return { installed: [], notes: ['依赖兼容性由对应加载器继续验证。'] };
  const added = [], quarantined = [];
  for (let attempt = 0; attempt < 24; attempt++) {
    const report = await inspectMods(directory, game);
    if (report.conflicts.length) { const error = new Error(report.conflicts.slice(0, 5).join('\n')); error.code = 'MOD_CHOICE_REQUIRED'; throw error; }
    for (const duplicate of report.duplicates) {
      const quarantine = path.join(path.dirname(directory), 'duplicate-mods');
      await fs.promises.mkdir(quarantine, { recursive: true });
      const target = path.join(quarantine, path.basename(duplicate));
      if (fs.existsSync(target)) throw new Error('重复模组的隔离目录已有同名文件，已保留供检查。');
      await fs.promises.rename(duplicate, target); quarantined.push(path.basename(duplicate));
    }
    if (!report.missing.length) return { installed: added, quarantined };
    const missing = report.missing[0];
    onProgress({ message: `正在为 ${missing.parent} 查找已验证的依赖 ${missing.id}…` });
    const hash = missing.root.sha512;
    const mapping = await fetchJson('https://api.modrinth.com/v2/version_files', 'api.modrinth.com', { method: 'POST', body: JSON.stringify({ hashes: [hash], algorithm: 'sha512' }) });
    const parent = mapping[hash];
    const dependencyRefs = parent?.files?.some(file => file.hashes?.sha512 === hash) ? (parent.dependencies || []).filter(dep => dep.dependency_type === 'required' && (dep.project_id || dep.version_id)) : [];
    let installed = false;
    for (const reference of dependencyRefs.slice(0, 16)) {
      const project = reference.project_id;
      if (project && !/^[A-Za-z0-9]+$/.test(project)) continue;
      if (reference.version_id && !/^[A-Za-z0-9]+$/.test(reference.version_id)) continue;
      const query = new URLSearchParams({ loaders: JSON.stringify(['fabric']), game_versions: JSON.stringify([game.minecraftVersion]) });
      const data = reference.version_id ? [await fetchJson(`https://api.modrinth.com/v2/version/${reference.version_id}`, 'api.modrinth.com')] : await fetchJson(`https://api.modrinth.com/v2/project/${project}/version?${query}`, 'api.modrinth.com');
      if (!Array.isArray(data)) continue;
      const versions = data.filter(v => (!project || v.project_id === project) && v.loaders?.includes('fabric') && v.game_versions?.includes(game.minecraftVersion));
      const version = versions.find(v => v.version_type === 'release') || versions[0];
      if (!version || !/^[A-Za-z0-9]+$/.test(version.project_id)) continue;
      const file = version.files?.find(file => file.primary) || version.files?.[0];
      if (!file || !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 || '') || path.basename(file.filename) !== file.filename || !file.filename.endsWith('.jar')) continue;
      const url = new URL(file.url);
      if (url.hostname !== 'cdn.modrinth.com' || !url.pathname.startsWith(`/data/${version.project_id}/`)) continue;
      await fs.promises.mkdir(cacheRoot, { recursive: true });
      const cached = path.join(cacheRoot, `${file.hashes.sha512}.jar`);
      if (fs.existsSync(cached) && crypto.createHash('sha512').update(await fs.promises.readFile(cached)).digest('hex') !== file.hashes.sha512.toLowerCase()) {
        await fs.promises.rename(cached, `${cached}.corrupt-${crypto.randomBytes(6).toString('hex')}`);
        onProgress({ message: `依赖 ${missing.id} 的缓存损坏，已保留原文件，正在重新下载…` });
      }
      if (!fs.existsSync(cached)) await downloadFile(file.url, cached, { hosts: ['cdn.modrinth.com'], hash: file.hashes.sha512, algorithm: 'sha512', size: file.size, maxBytes: 100 * 1024 * 1024, onRetry: onProgress });
      if (crypto.createHash('sha512').update(await fs.promises.readFile(cached)).digest('hex') !== file.hashes.sha512.toLowerCase()) throw new Error('依赖缓存校验失败，未安装。');
      const graph = await metadataGraph(cached);
      const metadata = graph.find(m => m.id === missing.id || m.provides?.includes(missing.id));
      if (!metadata || metadata.environment === 'client' || !matches(metadata.version, missing.range)) continue;
      // Do not inject a newer root that would replace an existing root through
      // a nested module. Ask the user to choose a version instead.
      const overlap = graph.find(m => report.installed.get(m.id)?.root);
      if (overlap) throw new Error(`补齐 ${missing.id} 将与已有 ${overlap.id} 重叠，需要选择版本。`);
      await fs.promises.copyFile(cached, path.join(directory, file.filename), fs.constants.COPYFILE_EXCL);
      added.push({ id: missing.id, file: file.filename, version: metadata.version }); installed = true; break;
    }
    if (!installed) {
      const error = new Error(`${missing.parent} 缺少依赖 ${missing.id} ${JSON.stringify(missing.range)}。未找到能从官方项目清单确认的安装文件。请把该依赖的对应版本加入原整合包后点击重试；原世界已保留。`);
      error.code = 'MOD_FILE_REQUIRED'; throw error;
    }
  }
  throw new Error('依赖补齐超过安全上限，已保留当前结果，请检查循环依赖。');
}
module.exports = { metadataGraph, matches, inspectMods, prepareModDependencies };
