const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

class WorkBuddyService {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.core = null;
    this.runtime = null;
    this.gateway = null;
    this.apiGateway = null;
    this.modelsCache = [];
  }

  moduleCandidates() {
    const unpackedCore = process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js')
      : '';
    return [
      process.env.WORKBUDDY_CONNECT_CORE,
      unpackedCore,
      path.join(__dirname, '..', '..', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js'),
      path.join(process.cwd(), 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js')
    ].filter((candidate, index, all) => Boolean(candidate) && all.indexOf(candidate) === index);
  }

  async loadCore() {
    if (this.core) return this.core;
    this.configureElectronBinary();
    const modulePath = this.moduleCandidates().find((candidate) => fs.existsSync(candidate));
    if (!modulePath) throw new Error('未找到 WorkBuddy 通道核心。请安装经济型通道组件。');
    const raw = await import(pathToFileURL(modulePath).href);
    this.core = {
      WorkBuddyUpstreamClient: raw.O,
      WorkBuddyCredentialStore: raw.m,
      CN_VARIANT: raw.S,
      FALLBACK_MODELS: raw.u,
      prepareChatBody: raw.P
    };
    if (!this.core.WorkBuddyUpstreamClient || !this.core.WorkBuddyCredentialStore) {
      throw new Error('WorkBuddy 通道核心版本不兼容。');
    }
    return this.core;
  }

  configureElectronBinary() {
    if (process.env.WORKBUDDY_ELECTRON_BIN) return process.env.WORKBUDDY_ELECTRON_BIN;
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'WorkBuddy', 'WorkBuddy.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'WorkBuddy', 'WorkBuddy.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'WorkBuddy', 'WorkBuddy.exe')
    ].filter(Boolean);
    const executable = candidates.find((candidate) => fs.existsSync(candidate));
    if (executable) process.env.WORKBUDDY_ELECTRON_BIN = executable;
    return executable || '';
  }

  electronBinary() {
    return this.configureElectronBinary();
  }

  async ensureRuntime() {
    if (this.runtime) return this.runtime;
    const core = await this.loadCore();
    const client = new core.WorkBuddyUpstreamClient();
    const ownPath = path.join(this.dataDirectory, '.workbuddy-auth.json');
    const store = new core.WorkBuddyCredentialStore({
      variant: core.CN_VARIANT,
      ownPath,
      refresh: (credential) => client.refreshToken(credential)
    });
    this.modelsCache = Array.from(core.FALLBACK_MODELS || []);
    this.runtime = { core, client, store };
    return this.runtime;
  }

  async status() {
    try {
      const { store } = await this.ensureRuntime();
      const status = await store.status();
      return {
        available: true,
        signedIn: status.state === 'signed-in',
        nickname: status.nickname || '',
        expiresAtMs: status.expiresAtMs || null,
        reason: friendlyReason(status.reason || ''),
        authPath: await store.resolvedDesktopAuthPath()
      };
    } catch (error) {
      const rawReason = String(error.message || error);
      return { available: false, signedIn: false, reason: friendlyReason(rawReason) };
    }
  }

  serializeModel(model) {
    return {
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImages: Boolean(model.supportsImages),
      credits: model.billing?.credits || '未知',
      free: Boolean(model.billing?.free),
      badges: model.billing?.badges || [],
      reasoning: model.reasoning || null
    };
  }

  async models() {
    const { client, store } = await this.ensureRuntime();
    const credential = await store.resolve();
    this.modelsCache = Array.from(await client.fetchModels(credential));
    return this.modelsCache.map((model) => this.serializeModel(model));
  }

  async startGateway() {
    if (this.gateway) return this.gateway.publicInfo();
    const { core, client, store } = await this.ensureRuntime();
    if (!this.modelsCache.length) await this.models();
    const secret = randomBytes(32).toString('base64url');
    const server = http.createServer(async (req, res) => {
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return writeError(res, 403, '仅允许本机访问');
      if (!validBearer(req.headers.authorization, secret)) return writeError(res, 401, '本地访问密钥无效');
      const url = req.url || '/';
      if (req.method === 'GET' && /^\/healthz\/?$/.test(url)) return writeJson(res, 200, { ok: true });
      if (req.method === 'GET' && /^\/v1\/models\/?$/.test(url)) {
        return writeJson(res, 200, { object: 'list', data: this.modelsCache.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: 'workbuddy' })) });
      }
      if (req.method !== 'POST' || !/^\/v1\/chat\/completions\/?$/.test(url)) return writeError(res, 404, '接口不存在');
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return writeError(res, 415, '请求必须是 JSON');
      try {
        const raw = await readBody(req, 8 * 1024 * 1024);
        const credential = await store.resolve();
        const prepared = core.prepareChatBody(raw.toString('utf8'));
        const result = await client.chatStream(credential, prepared);
        if (!result.ok) return writeError(res, result.status === 401 ? 401 : 502, `WorkBuddy 请求失败：${String(result.message).slice(0, 300)}`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        Readable.fromWeb(result.response.body).pipe(res);
      } catch (error) {
        writeError(res, 500, String(error.message || error));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    this.gateway = {
      publicInfo: () => ({ baseUrl: `http://127.0.0.1:${port}`, token: secret }),
      close: () => new Promise((resolve) => server.close(resolve))
    };
    return this.gateway.publicInfo();
  }

  async stopGateway() {
    if (this.gateway) await this.gateway.close();
    if (this.apiGateway) await this.apiGateway.close();
    this.gateway = null;
    this.apiGateway = null;
  }

  async startApiGateway({ baseUrl, modelId, apiKey }) {
    if (this.apiGateway) return this.apiGateway.publicInfo();
    if (!baseUrl || !modelId || !apiKey) throw new Error('自备 API 配置不完整。');
    const secret = randomBytes(32).toString('base64url');
    const endpoint = chatEndpoint(baseUrl);
    const server = http.createServer(async (req, res) => {
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return writeError(res, 403, '仅允许本机访问');
      if (!validBearer(req.headers.authorization, secret)) return writeError(res, 401, '本地访问密钥无效');
      const url = req.url || '/';
      if (req.method === 'GET' && /^\/healthz\/?$/.test(url)) return writeJson(res, 200, { ok: true });
      if (req.method === 'GET' && /^\/v1\/models\/?$/.test(url)) return writeJson(res, 200, { object: 'list', data: [{ id: modelId, object: 'model', created: 0, owned_by: 'user' }] });
      if (req.method !== 'POST' || !/^\/v1\/chat\/completions\/?$/.test(url)) return writeError(res, 404, '接口不存在');
      try {
        const raw = await readBody(req, 8 * 1024 * 1024);
        const body = JSON.parse(raw.toString('utf8'));
        body.model = modelId;
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body)
        });
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
      } catch (error) {
        writeError(res, 502, `自备 API 请求失败：${String(error.message || error).slice(0, 300)}`);
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    this.apiGateway = {
      publicInfo: () => ({ baseUrl: `http://127.0.0.1:${port}`, token: secret }),
      close: () => new Promise((resolve) => server.close(resolve))
    };
    return this.apiGateway.publicInfo();
  }
}

function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function friendlyReason(reason) {
  const rawReason = String(reason || '');
  return /key helper.*EACCES/i.test(rawReason)
    ? 'WorkBuddy 当前被设置为“以管理员身份运行”，普通权限的配置器无法读取登录凭据。请取消 WorkBuddy 属性 → 兼容性 → 以管理员身份运行，再重新检测账号。'
    : rawReason;
}

function validBearer(header, secret) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('请求内容过大'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function writeError(res, status, message) {
  writeJson(res, status, { error: { message, type: 'local_gateway_error', code: status } });
}

module.exports = { WorkBuddyService };
