const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const nbt = require('prismarine-nbt');

async function writeJson(file, value) {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await fs.promises.rename(temp, file);
}
async function readJson(file) { try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; } }
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
async function worldManifest(directory) {
  const result = {};
  async function visit(folder) {
    if ((await fs.promises.lstat(folder)).isSymbolicLink()) throw new Error('世界中包含目录链接，无法安全自动恢复。');
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('世界中包含文件链接，无法安全自动恢复。');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name !== 'session.lock') {
        const hash = crypto.createHash('sha256');
        for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
        result[path.relative(directory, file).replaceAll('\\', '/')] = hash.digest('hex');
      }
    }
  }
  await visit(directory);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
function manifestsEqual(a, b) { return Boolean(a && b) && JSON.stringify(a) === JSON.stringify(b); }
async function snapshotWorld(source, backupsRoot, details = {}) {
  const before = await worldManifest(source);
  if (!before['level.dat']) throw new Error('世界中缺少 level.dat，已保留原目录。');
  // Reading an OS-locked session.lock fails on Windows; do not bypass it.
  const lock = path.join(source, 'session.lock');
  if (fs.existsSync(lock)) await fs.promises.readFile(lock);
  await fs.promises.mkdir(backupsRoot, { recursive: true });
  const backup = await fs.promises.mkdtemp(path.join(backupsRoot, 'world-'));
  const copy = path.join(backup, 'world');
  await fs.promises.cp(source, copy, { recursive: true, force: false, errorOnExist: true, filter: file => path.basename(file) !== 'session.lock' });
  const [after, copied] = await Promise.all([worldManifest(source), worldManifest(copy)]);
  if (!manifestsEqual(before, after) || !manifestsEqual(before, copied)) throw new Error(`世界在备份期间发生变化或备份校验失败，已停止恢复。检查目录：${backup}`);
  await writeJson(path.join(backup, 'manifest.json'), { ...details, source, createdAt: new Date().toISOString(), files: copied });
  return { path: backup, world: copy, files: copied };
}
function parseNbt(data, compressed = true) {
  const raw = compressed ? zlib.gunzipSync(data, { maxOutputLength: 128 * 1024 * 1024 }) : data;
  if (raw.length > 128 * 1024 * 1024) throw new Error('NBT 数据过大');
  return nbt.simplify(nbt.parseUncompressed(raw));
}
async function validateWorld(directory, onProgress = () => {}) {
  let level;
  try { level = parseNbt(await fs.promises.readFile(path.join(directory, 'level.dat'))); if (!level.Data || !Number.isInteger(level.Data.DataVersion)) throw new Error('缺少世界版本数据'); }
  catch (error) { throw new Error(`世界主文件无法验证：${error.message}。原文件已保留，请从备份恢复。`); }
  let chunks = 0, players = 0;
  async function scan(folder) {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('世界中包含链接，已停止自动恢复。');
      if (entry.isDirectory()) { await scan(file); continue; }
      if (!entry.isFile()) continue;
      if (/\.dat$/i.test(entry.name) && path.basename(folder) === 'playerdata') {
        try { parseNbt(await fs.promises.readFile(file)); players++; }
        catch { throw new Error(`玩家数据损坏：${entry.name}。原世界和备份均已保留。`); }
      }
      if (!/\.mca$/i.test(entry.name) || !['region', 'entities', 'poi'].includes(path.basename(folder))) continue;
      const handle = await fs.promises.open(file, 'r');
      try {
        const size = (await handle.stat()).size;
        if (!size) continue; // Minecraft sometimes leaves empty, unused regions.
        if (size < 8192) throw new Error('区域文件头不完整');
        const header = Buffer.alloc(8192); await handle.read(header, 0, header.length, 0);
        const used = new Set([0, 1]);
        for (let i = 0; i < 1024; i++) {
          const loc = header.readUInt32BE(i * 4), sector = loc >>> 8, count = loc & 255;
          if (!loc) continue;
          if (sector < 2 || !count || sector * 4096 + 5 > size) throw new Error('区块偏移无效');
          for (let s = sector; s < sector + count; s++) { if (used.has(s)) throw new Error('区块存储位置重叠'); used.add(s); }
          const prefix = Buffer.alloc(5); await handle.read(prefix, 0, 5, sector * 4096);
          const length = prefix.readUInt32BE(0), format = prefix[4];
          if (format & 128) throw new Error('此世界使用外置区块文件，需要手动检查');
          if (length < 2 || length > count * 4096 - 4 || sector * 4096 + 4 + length > size) throw new Error('区块数据不完整');
          const data = Buffer.alloc(length - 1); await handle.read(data, 0, data.length, sector * 4096 + 5);
          const raw = format === 2 ? zlib.inflateSync(data, { maxOutputLength: 128 * 1024 * 1024 }) : format === 1 ? zlib.gunzipSync(data, { maxOutputLength: 128 * 1024 * 1024 }) : format === 3 ? data : null;
          if (!raw) throw new Error(`暂无法自动校验压缩类型 ${format}`);
          parseNbt(raw, false); chunks++;
          if (chunks % 128 === 0) { onProgress({ chunks, players }); await new Promise(resolve => setImmediate(resolve)); }
        }
      } catch (error) { throw new Error(`世界校验未通过：${path.relative(directory, file)}，${error.message}。已保留备份，请选择恢复文件。`); }
      finally { await handle.close(); }
    }
  }
  await scan(directory);
  return { chunks, players, dataVersion: level.Data.DataVersion, name: level.Data.LevelName || '' };
}
async function recordSession(directory, update) {
  const file = path.join(directory, '.minebot-session.json');
  const old = await readJson(file) || {};
  await writeJson(file, { ...old, ...update, updatedAt: new Date().toISOString() });
}
async function selectWorld({ buildsRoot, instanceRoot, sourceWorld, worldPath, backupsRoot, onProgress = () => {} }) {
  const prior = fs.existsSync(buildsRoot) ? (await fs.promises.readdir(buildsRoot, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => path.join(buildsRoot, x.name)).sort().reverse() : [];
  for (const build of prior) {
    const info = await readJson(path.join(build, 'build-info.json'));
    if (!info || !samePath(info.sourceInstance || '', instanceRoot) || !samePath(info.sourceWorld || '', sourceWorld)) continue;
    const world = path.join(build, 'world');
    if (!fs.existsSync(path.join(world, 'level.dat'))) continue;
    const session = await readJson(path.join(build, '.minebot-session.json'));
    if (session?.pid && ['launching', 'ready', 'stopping'].includes(session.phase)) {
      let alive = false; try { process.kill(session.pid, 0); alive = true; } catch (e) { if (e.code !== 'ESRCH') alive = true; }
      if (alive) throw new Error(`上次服务器进程 ${session.pid} 仍可能运行，请先在监管中心停止它；未读取或覆盖正在使用的世界。`);
    }
    if (fs.existsSync(path.join(build, '.minebot-clean-stop'))) return { world, recovered: false, build };
    const baseline = await readJson(path.join(build, '.minebot-world-baseline.json'));
    const current = await worldManifest(world);
    // An unchanged workspace that never reached ready cannot contain new play
    // progress. It can be continued without inventing a clean-shutdown marker.
    if (baseline && session && !session.everReady && manifestsEqual(baseline, current)) return { world, recovered: false, build, reason: '上次在游戏启动前失败，已自动继续未改动的世界。' };
    if (info.parentWorld) {
      const parent = path.resolve(info.parentWorld), parentBuild = path.dirname(parent), relative = path.relative(buildsRoot, parentBuild);
      if (path.basename(parent) === 'world' && relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep).length === 1 && fs.existsSync(path.join(parentBuild, '.minebot-clean-stop'))) {
        const savedFiles = await worldManifest(parent);
        if (manifestsEqual(savedFiles, current)) return { world, recovered: false, build, reason: '上次启动副本与安全保存的世界完全一致，已自动继续最新进度。' };
      }
    }
    onProgress({ message: '正在备份并校验上次未正常停止的世界…' });
    const backup = await snapshotWorld(world, backupsRoot, { reason: 'unclean-stop', build });
    let report;
    try { report = await validateWorld(backup.world, value => onProgress({ message: `正在校验世界：已检查 ${value.chunks} 个区块…` })); }
    catch (error) { const failure = new Error(`上次服务器未确认安全停服；${error.message} 备份：${backup.path}`); failure.code = 'WORLD_CHOICE_REQUIRED'; failure.backupPath = backup.path; throw failure; }
    await writeJson(path.join(backup.path, 'validation.json'), report);
    return { world: backup.world, recovered: true, build, backupPath: backup.path, report, reason: `已备份并校验恢复世界（${report.chunks} 个区块）。未落盘的进度无法保证恢复。` };
  }
  return { world: worldPath || '', recovered: false };
}
module.exports = { worldManifest, manifestsEqual, snapshotWorld, validateWorld, selectWorld, recordSession, writeJson, readJson };
