const fs = require('node:fs');
const path = require('node:path');
const { downloadFile } = require('./downloads.cjs');

function checkedRelative(value) {
  const input = String(value || '').replaceAll('\\', '/');
  const parts = input.split('/');
  if (!input || input.startsWith('/') || parts.some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`整合包文件路径无效：${input.slice(0, 200)}`);
  return parts.join('/');
}

async function prepareMrpack(stage) {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(stage, 'modrinth.index.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || manifest.game !== 'minecraft' || !Array.isArray(manifest.files) || manifest.files.length > 25000) throw new Error('不支持该 Modrinth 整合包清单。');
  const normal = path.join(stage, 'overrides'), serverOnly = path.join(stage, 'server-overrides');
  await fs.promises.mkdir(normal, { recursive: true });
  const excluded = [];
  const seen = new Set();
  let total = 0, downloaded = 0;
  for (const file of manifest.files) {
    const relative = checkedRelative(file.path);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`整合包包含重复路径：${relative}`);
    seen.add(key);
    const onClient = file.env?.client !== 'unsupported';
    const onServer = file.env?.server !== 'unsupported';
    if (!onClient && !onServer) continue;
    if (!onServer) excluded.push(relative);
    const base = onClient ? normal : serverOnly;
    const target = path.resolve(base, ...relative.split('/'));
    if (!target.startsWith(`${path.resolve(base)}${path.sep}`)) throw new Error('整合包目标路径越界。');
    const size = Number(file.fileSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > 200 * 1024 * 1024 || (total += size) > 20 * 1024 * 1024 * 1024) throw new Error('整合包资源大小无效或超过限制。');
    const sha = file.hashes?.sha512 || file.hashes?.sha1;
    const algorithm = file.hashes?.sha512 ? 'sha512' : 'sha1';
    if (!new RegExp(`^[0-9a-f]{${algorithm === 'sha512' ? 128 : 40}}$`, 'i').test(sha || '')) throw new Error(`整合包资源缺少完整校验值：${relative}`);
    // Explicit override files in the archive intentionally take precedence.
    if (fs.existsSync(target)) continue;
    const url = (file.downloads || []).find(link => { try { const u = new URL(link); return u.protocol === 'https:' && u.hostname === 'cdn.modrinth.com'; } catch { return false; } });
    if (!url) throw new Error(`资源 ${relative} 没有受支持的 Modrinth 下载地址。`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await downloadFile(url, target, { hosts: ['cdn.modrinth.com'], algorithm, hash: sha, size, maxBytes: 200 * 1024 * 1024 });
    downloaded++;
  }
  await fs.promises.writeFile(path.join(stage, '.minebot-mrpack.json'), JSON.stringify({ version: 1, serverExcluded: excluded, downloaded }, null, 2));
  return { downloaded, serverExcluded: excluded };
}
module.exports = { checkedRelative, prepareMrpack };
