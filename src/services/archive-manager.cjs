const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const extractZip = require('extract-zip');

const execFileAsync = promisify(execFile);
const SUPPORTED_EXTENSIONS = new Set(['.zip', '.mrpack', '.7z']);
const MAX_EXTRACTED_FILES = 250000;
const MAX_EXTRACTED_BYTES = 20 * 1024 * 1024 * 1024;

class ArchiveManager {
  constructor(dataDirectory, inspectInstance) {
    this.root = path.join(dataDirectory, 'imports');
    this.inspectInstance = inspectInstance;
  }

  async prepare(archivePath) {
    const source = path.resolve(String(archivePath || ''));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('整合包文件不存在，请重新选择。');
    const extension = path.extname(source).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('目前支持 ZIP、MRPACK 和 7Z 整合包。');
    const stat = fs.statSync(source);
    const fingerprint = crypto.createHash('sha256').update(`${source.toLowerCase()}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 16);
    const destination = path.join(this.root, fingerprint);
    const markerPath = path.join(destination, '.jingban-import.json');
    if (fs.existsSync(markerPath)) {
      const marker = readJson(markerPath);
      if (marker?.root && isInside(destination, marker.root) && fs.existsSync(marker.root)) {
        return this.result(source, destination, marker.root, true);
      }
    }

    const zip = extension === '.zip' || extension === '.mrpack';
    const tar = zip ? '' : resolveTarExecutable();
    if (!zip && !tar) throw new Error('Windows 压缩包组件不可用，请先手动解压，再选择“已解压目录”。');
    const entries = zip ? await listZip(source) : await listArchive(tar, source);
    validateArchiveEntries(entries);
    await fs.promises.mkdir(this.root, { recursive: true });
    assertFreeSpace(this.root, stat.size);
    const stage = path.join(this.root, `.${fingerprint}-${process.pid}-${Date.now()}`);
    await fs.promises.mkdir(stage, { recursive: true });
    try {
      if (zip) await extractZip(source, { dir: stage });
      else await execFileAsync(tar, ['-xf', source, '-C', stage], { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      validateExtractedTree(stage);
      const root = findPackRoot(stage);
      if (!root) throw new Error('压缩包内没有找到 mods、config、saves 或 world 目录，它可能只是不含实际模组的下载清单。');
      const relativeRoot = path.relative(stage, root);
      await fs.promises.rm(destination, { recursive: true, force: true });
      await fs.promises.rename(stage, destination);
      const finalRoot = path.join(destination, relativeRoot);
      await fs.promises.writeFile(markerPath, `${JSON.stringify({ source, root: finalRoot, importedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      return this.result(source, destination, finalRoot, false);
    } catch (error) {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw new Error(`整合包验证或解压失败：${error.message || error}`);
    }
  }

  result(source, destination, root, reused) {
    const inspection = this.inspectInstance(root);
    return { archivePath: source, extractedDirectory: destination, root, reused, inspection };
  }
}

function listZip(source) {
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(new Error(`无法读取压缩包：${error.message}`));
      const entries = [];
      let bytes = 0;
      archive.on('error', reject);
      archive.on('end', () => entries.length ? resolve(entries) : reject(new Error('压缩包为空或无法读取。')));
      archive.on('entry', (entry) => {
        try {
          validateArchiveEntries([entry.fileName]);
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('压缩包包含不允许的符号链接。');
          entries.push(entry.fileName);
          bytes += entry.uncompressedSize;
          if (entries.length > MAX_EXTRACTED_FILES || bytes > MAX_EXTRACTED_BYTES) throw new Error('压缩包内容超过允许的大小或文件数。');
          archive.readEntry();
        } catch (error) { archive.close(); reject(error); }
      });
      archive.readEntry();
    });
  });
}

function resolveTarExecutable() {
  const candidates = [
    process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'tar.exe'),
    'tar.exe'
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'tar.exe' || fs.existsSync(candidate)) || '';
}

async function listArchive(tar, source) {
  try {
    const { stdout } = await execFileAsync(tar, ['-tf', source], { timeout: 2 * 60 * 1000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const entries = String(stdout || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (!entries.length) throw new Error('压缩包为空或无法读取。');
    return entries;
  } catch (error) {
    throw new Error(`无法读取压缩包：${String(error.stderr || error.message || error).trim()}`);
  }
}

function validateArchiveEntries(entries) {
  for (const raw of entries) {
    const normalized = String(raw).replaceAll('\\', '/');
    const parts = normalized.split('/').filter(Boolean);
    if (/^(?:[A-Za-z]:|\/)/.test(normalized) || parts.includes('..')) {
      throw new Error(`压缩包包含不安全路径：${raw}`);
    }
  }
  return true;
}

function assertFreeSpace(directory, archiveBytes) {
  if (typeof fs.statfsSync !== 'function') return true;
  const stats = fs.statfsSync(directory);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const required = Math.max(2 * 1024 * 1024 * 1024, Number(archiveBytes || 0) * 2);
  if (Number.isFinite(freeBytes) && freeBytes < required) {
    throw new Error(`磁盘可用空间不足。导入前至少需要 ${Math.ceil(required / 1024 / 1024 / 1024)} GB 可用空间。`);
  }
  return true;
}

function validateExtractedTree(root) {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`压缩包包含不允许的符号链接：${entry.name}`);
      if (stat.isDirectory()) stack.push(target);
      else {
        files += 1;
        bytes += stat.size;
        if (files > MAX_EXTRACTED_FILES) throw new Error(`压缩包文件数超过 ${MAX_EXTRACTED_FILES}，已停止导入。`);
        if (bytes > MAX_EXTRACTED_BYTES) throw new Error('解压后总大小超过 20 GB，已停止导入。');
      }
    }
  }
  return { files, bytes };
}

function findPackRoot(extractedRoot, maxDepth = 4) {
  let best = null;
  const visit = (directory, depth) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    const score = Number(names.has('saves')) * 10
      + Number(names.has('world')) * 10
      + Number(names.has('mods')) * 8
      + Number(names.has('config')) * 4
      + Number(names.has('defaultconfigs')) * 2
      + Number(names.has('options.txt'));
    if (score > 0 && (!best || score > best.score)) best = { directory, score };
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || ['__macosx', '.git'].includes(entry.name.toLowerCase())) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(extractedRoot, 0);
  if (!best) return '';
  if (path.basename(best.directory).toLowerCase() === 'overrides') {
    const parent = path.dirname(best.directory);
    if (fs.existsSync(path.join(parent, 'manifest.json')) || fs.existsSync(path.join(parent, 'modrinth.index.json'))) return parent;
  }
  return best.directory;
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readJson(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
}

module.exports = { ArchiveManager, SUPPORTED_EXTENSIONS, MAX_EXTRACTED_FILES, MAX_EXTRACTED_BYTES, validateArchiveEntries, validateExtractedTree, findPackRoot, resolveTarExecutable };

