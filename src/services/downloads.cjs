const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function retryable(error) {
  return Boolean(error.retryable || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.code || error.cause?.code)
    || error.name === 'TimeoutError' || (error instanceof TypeError && /fetch failed|terminated/i.test(error.message)));
}
async function withRetry(operation, options = {}) {
  const retries = Math.max(0, Math.min(3, options.retries ?? 2));
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (options.signal?.aborted || attempt >= retries || !retryable(error)) throw error;
      options.onRetry?.({ attempt: attempt + 1, message: '网络暂时中断，正在自动重试…' });
      const delay = options.retryDelayMs ?? 700 * (2 ** attempt);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
async function downloadOnce(url, target, options = {}) {
  const hosts = new Set(options.hosts || []);
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || !hosts.has(initial.hostname) || initial.username || initial.password) throw new Error('下载地址不是允许的 HTTPS 来源。');
  let current = initial, response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const timeout = AbortSignal.timeout(options.timeout || 120000);
    response = await fetch(current, { signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout, redirect: 'manual', headers: { 'User-Agent': 'minebot-desktop/1.0 (Minecraft server configuration)' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirects === 5) throw new Error('下载重定向次数过多或地址缺失。');
    current = new URL(location, current);
    if (current.protocol !== 'https:' || !hosts.has(current.hostname) || current.username || current.password) throw new Error('下载重定向到未允许的地址。');
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    const error = new Error(`下载失败（HTTP ${response?.status || '未知'}）：${initial.hostname}`);
    error.retryable = [408, 425, 429].includes(response?.status) || response?.status >= 500;
    throw error;
  }
  const maxBytes = options.maxBytes || 200 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('下载文件超过大小限制。');
  const hash = crypto.createHash(options.algorithm || 'sha256');
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;
  let bytes = 0;
  const source = Readable.fromWeb(response.body);
  let reported = 0;
  source.on('data', chunk => { bytes += chunk.length; hash.update(chunk); if (bytes > maxBytes) source.destroy(new Error('下载文件超过大小限制。')); if (Date.now() - reported > 500) { reported = Date.now(); options.onProgress?.({ bytes, total: options.size || declared || null }); } });
  try {
    await pipeline(source, fs.createWriteStream(temp, { flags: 'wx', flush: true }));
    const actual = hash.digest('hex');
    if (options.hash && actual.toLowerCase() !== options.hash.toLowerCase()) throw new Error('下载文件校验失败。');
    if (options.size != null && bytes !== Number(options.size)) throw new Error('下载文件大小与清单不一致。');
    if (bytes < (options.minBytes ?? 1)) throw new Error('下载文件不完整。');
    // link() is atomic and fails if an existing file would be overwritten.
    try { await fs.promises.link(temp, target); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
      await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
    }
    await fs.promises.unlink(temp);
    return { hash: actual, bytes };
  } catch (error) { await fs.promises.rm(temp, { force: true }).catch(() => {}); throw error; }
}

async function downloadFile(url, target, options = {}) { return withRetry(() => downloadOnce(url, target, options), options); }
async function fetchTextOnce(url, allowedHost, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== allowedHost || parsed.username || parsed.password) throw new Error('元数据来源不受信任。');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(options.timeout || 30000), redirect: 'error', method: options.method || 'GET', body: options.body, headers: { 'User-Agent': 'minebot-desktop/1.0 (Minecraft server configuration)', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) { const error = new Error(`无法读取版本信息（HTTP ${response.status}）：${parsed.hostname}`); error.retryable = [408, 429].includes(response.status) || response.status >= 500; await response.body?.cancel().catch(() => {}); throw error; }
  const chunks = []; let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) { size += chunk.length; if (size > (options.maxBytes || 16 * 1024 * 1024)) throw new Error('版本信息异常过大。'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchText(url, allowedHost, options = {}) { return withRetry(() => fetchTextOnce(url, allowedHost, options), options); }
async function fetchJson(url, allowedHost, options = {}) { return JSON.parse(await fetchText(url, allowedHost, options)); }
module.exports = { downloadFile, fetchJson, fetchText, withRetry };
