const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const { downloadFile, fetchJson } = require('./downloads.cjs');

const PROJECTS = Object.freeze({ voice: '9eGKb6K1', fabricApi: 'P7dR8mSH' });

function fabricMetadata(file) {
  return new Promise(resolve => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return resolve(null);
      let finished = false;
      const done = value => { if (finished) return; finished = true; try { zip.close(); } catch {} resolve(value); };
      zip.on('error', () => done(null)); zip.on('end', () => done(null));
      zip.on('entry', entry => {
        if (entry.fileName !== 'fabric.mod.json' || entry.uncompressedSize > 1024 * 1024) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return done(null);
          const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', () => done(null));
          stream.on('end', () => { try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); } });
        });
      });
      zip.readEntry();
    });
  });
}

async function inspectInstalled(directory, loader) {
  if (!fs.existsSync(directory)) return { voice: '', fabricApi: '' };
  const result = { voice: '', voiceVersion: '', fabricApi: '' };
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const metadata = loader === 'fabric' ? await fabricMetadata(file) : null;
    if (metadata?.id === 'voicechat' || /(?:^|[^a-z])voicechat(?:[^a-z]|$)|simple.?voice.?chat/i.test(entry.name)) { result.voice = file; result.voiceVersion = String(metadata?.version || entry.name); }
    if (metadata?.id === 'fabric-api' || metadata?.id === 'fabric' || metadata?.provides?.includes?.('fabric') || /fabric-api/i.test(entry.name)) result.fabricApi = file;
  }
  return result;
}

async function obtainMod(cache, project, game, loader) {
  if (!Object.values(PROJECTS).includes(project)) throw new Error('只能自动安装已知的必要模组。');
  const query = new URLSearchParams({ loaders: JSON.stringify([loader]), game_versions: JSON.stringify([game]) });
  const versions = await fetchJson(`https://api.modrinth.com/v2/project/${project}/version?${query}`, 'api.modrinth.com');
  const compatible = Array.isArray(versions) ? versions.filter(v => v.project_id === project && v.loaders?.includes(loader) && v.game_versions?.includes(game)) : [];
  const selected = compatible.find(v => v.version_type === 'release') || compatible[0];
  if (!selected) throw new Error(`没有找到适用于 Minecraft ${game} / ${loader} 的必要模组版本。`);
  const required = (selected.dependencies || []).filter(dep => dep.dependency_type === 'required' && (!dep.project_id || !Object.values(PROJECTS).includes(dep.project_id)));
  if (required.length) throw new Error(`必要模组还依赖未自动验证的项目：${required.map(x => x.project_id || x.version_id || x.file_name || '未知依赖').join('、')}。`);
  const file = selected.files?.find(f => f.primary) || selected.files?.[0];
  const sha = file?.hashes?.sha512;
  if (!file || !/^[0-9a-f]{128}$/i.test(sha || '') || path.basename(file.filename) !== file.filename || !/\.jar$/i.test(file.filename)) throw new Error('模组版本清单缺少有效文件或 SHA-512 校验值。');
  const url = new URL(file.url);
  if (url.hostname !== 'cdn.modrinth.com' || !url.pathname.startsWith(`/data/${project}/`)) throw new Error('必要模组下载地址与项目不一致。');
  await fs.promises.mkdir(cache, { recursive: true });
  const cached = path.join(cache, `${sha.toLowerCase()}.jar`);
  if (fs.existsSync(cached)) {
    const actual = crypto.createHash('sha512').update(await fs.promises.readFile(cached)).digest('hex');
    if (actual !== sha.toLowerCase()) await fs.promises.rename(cached, `${cached}.corrupt-${crypto.randomBytes(6).toString('hex')}`);
  }
  if (!fs.existsSync(cached)) {
    await downloadFile(file.url, cached, { hosts: ['cdn.modrinth.com'], hash: sha, algorithm: 'sha512', size: file.size, maxBytes: 100 * 1024 * 1024 });
  }
  return { project, filename: file.filename, cached, version: selected.version_number, sha512: sha.toLowerCase() };
}

async function copyNew(source, directory, filename) {
  await fs.promises.mkdir(directory, { recursive: true });
  const target = path.join(directory, filename);
  try { await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL); return target; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const [a, b] = await Promise.all([fs.promises.readFile(source), fs.promises.readFile(target)]);
    if (!a.equals(b)) throw new Error(`已有不同内容的模组文件 ${filename}；为保护原文件，未覆盖。`);
    return '';
  }
}

async function prepareVoiceMods({ game, instanceRoot, serverDirectory, cacheRoot }) {
  const loader = String(game.modLoader || '').toLowerCase();
  if (!['fabric', 'forge', 'neoforge'].includes(loader)) throw new Error('语音模组需要 Fabric、Forge 或 NeoForge 加载器。');
  const clientMods = path.join(instanceRoot, 'mods');
  const serverMods = path.join(serverDirectory, 'mods');
  const client = await inspectInstalled(clientMods, loader);
  const server = await inspectInstalled(serverMods, loader);
  const installed = [];
  const created = [];
  const install = async (source, directory, filename) => {
    const target = await copyNew(source, directory, filename);
    if (target) { installed.push(target); created.push({ target, source, directory }); }
  };
  try {
  if (loader === 'fabric' && !client.fabricApi && !server.fabricApi) {
    const dependency = await obtainMod(cacheRoot, PROJECTS.fabricApi, game.minecraftVersion, loader);
    for (const directory of [serverMods, clientMods]) await install(dependency.cached, directory, dependency.filename);
  } else if (loader === 'fabric' && Boolean(client.fabricApi) !== Boolean(server.fabricApi)) {
    const source = client.fabricApi || server.fabricApi;
    await install(source, client.fabricApi ? serverMods : clientMods, path.basename(source));
  }
  if (!client.voice && !server.voice) {
    const voice = await obtainMod(cacheRoot, PROJECTS.voice, game.minecraftVersion, loader);
    for (const directory of [serverMods, clientMods]) await install(voice.cached, directory, voice.filename);
  } else if (Boolean(client.voice) !== Boolean(server.voice)) {
    const source = client.voice || server.voice;
    await install(source, client.voice ? serverMods : clientMods, path.basename(source));
  } else if (client.voice && server.voice) {
    const [clientHash, serverHash] = await Promise.all([fs.promises.readFile(client.voice), fs.promises.readFile(server.voice)]);
    if (!clientHash.equals(serverHash)) throw new Error('客户端与服务端的语音模组不同，已停止自动配置，避免覆盖现有文件。');
  }
  return installed;
  } catch (error) {
    // Only remove files created by this call, after verifying both path and
    // content. Never undo a user's concurrent edit or touch pre-existing mods.
    for (const item of created.reverse()) {
      try {
        if (!path.resolve(item.target).startsWith(`${path.resolve(item.directory)}${path.sep}`)) continue;
        const [now, original] = await Promise.all([fs.promises.readFile(item.target), fs.promises.readFile(item.source)]);
        if (now.equals(original)) await fs.promises.unlink(item.target);
      } catch {}
    }
    throw error;
  }
}

module.exports = { PROJECTS, fabricMetadata, inspectInstalled, obtainMod, prepareVoiceMods };
