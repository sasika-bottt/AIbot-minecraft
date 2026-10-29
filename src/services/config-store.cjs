const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = {
  schemaVersion: 8,
  completedStep: 0,
  model: {
    channel: 'workbuddy',
    workbuddyModel: '',
    workbuddyEffort: 'default',
    provider: 'openai-compatible',
    baseUrl: '',
    modelId: '',
    hasApiKey: false
  },
  game: {
    source: 'pcl2',
    launcher: 'pcl2',
    instancePath: '',
    worldPath: '',
    archivePath: '',
    minecraftVersion: '',
    modLoader: '',
    loaderVersion: '',
    javaMajor: 0
  },
  server: {
    templatePath: '',
    lastBuildDirectory: '',
    administrators: [],
    revokedAdministrators: []
  },
  resources: {
    voiceEnabled: false,
    voiceMod: 'simple-voice-chat',
    requiredModNames: ['Simple Voice Chat'],
    userManagesMods: true,
    ttsVoice: '',
    sttModel: 'small'
  },
  persona: {
    name: '',
    description: '',
    replyStyle: '简短、自然、使用简体中文',
    proactive: true,
    skinMode: 'import',
    skinPath: '',
    builtinSkin: ''
  },
  network: {
    mode: 'lan',
    gameAddress: '',
    voiceAddress: '',
    gameLocalPort: 25565,
    voiceLocalPort: 24454,
    autoDetect: true
  },
  behavior: {
    selfPreservation: true,
    unstuck: true,
    selfDefense: true,
    itemCollecting: true,
    torchPlacing: true,
    idleStaring: true,
    buildSteward: true,
    buildStewardMode: 'manual',
    requireBuildApproval: true,
    hunting: false,
    cheat: false
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

class ConfigStore {
  constructor(userDataPath, safeStorage) {
    this.safeStorage = safeStorage;
    this.dir = path.join(userDataPath, 'profile');
    this.configPath = path.join(this.dir, 'config.json');
    this.secretPath = path.join(this.dir, 'secrets.bin');
    this.previousPath = path.join(this.dir, 'config.previous.json');
    this.recoveryNotice = '';
    fs.mkdirSync(this.dir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.configPath)) return clone(DEFAULT_CONFIG);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      const normalized = merge(clone(DEFAULT_CONFIG), parsed);
      if ((parsed.schemaVersion || 1) < 2 && normalized.game.source === 'launcher') {
        normalized.game.source = 'pcl2';
      }
      if ((parsed.schemaVersion || 1) < 3) normalized.resources.voiceEnabled = false;
      if (/^zh-CN-.*Neural$/i.test(normalized.resources.ttsVoice || '')) normalized.resources.ttsVoice = '';
      if (!['manual', 'admin'].includes(normalized.behavior.buildStewardMode)) normalized.behavior.buildStewardMode = 'manual';
      if (normalized.game.source === 'launcher') normalized.game.source = 'pcl2';
      normalized.schemaVersion = DEFAULT_CONFIG.schemaVersion;
      delete normalized.resources.autoDownload;
      normalized.network.gameLocalPort = normalizePort(normalized.network.gameLocalPort, 25565);
      normalized.network.voiceLocalPort = normalizePort(normalized.network.voiceLocalPort, 24454);
      normalized.server.administrators = normalizeAdministrators(normalized.server.administrators);
      normalized.server.revokedAdministrators = normalizeAdministrators(normalized.server.revokedAdministrators);
      return normalized;
    } catch (error) {
      const backup = path.join(this.dir, `config.corrupt-${fileStamp(new Date())}.json`);
      try { fs.renameSync(this.configPath, backup); } catch {}
      this.recoveryNotice = `上次配置文件无法读取，已保留为 ${path.basename(backup)} 并恢复默认设置。`;
      return clone(DEFAULT_CONFIG);
    }
  }

  save(next) {
    const normalized = merge(clone(DEFAULT_CONFIG), next);
    normalized.schemaVersion = DEFAULT_CONFIG.schemaVersion;
    delete normalized.resources.autoDownload;
    normalized.network.gameLocalPort = normalizePort(normalized.network.gameLocalPort, 25565);
    normalized.network.voiceLocalPort = normalizePort(normalized.network.voiceLocalPort, 24454);
    normalized.server.administrators = normalizeAdministrators(normalized.server.administrators);
    normalized.server.revokedAdministrators = normalizeAdministrators(normalized.server.revokedAdministrators);
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    if (fs.existsSync(this.configPath)) fs.copyFileSync(this.configPath, this.previousPath);
    fs.renameSync(tmp, this.configPath);
    return normalized;
  }

  consumeRecoveryNotice() {
    const notice = this.recoveryNotice;
    this.recoveryNotice = '';
    return notice;
  }

  saveApiKey(apiKey) {
    if (!apiKey) {
      if (fs.existsSync(this.secretPath)) fs.rmSync(this.secretPath, { force: true });
      return false;
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 系统加密当前不可用，配置器拒绝明文保存 API Key。');
    }
    fs.writeFileSync(this.secretPath, this.safeStorage.encryptString(apiKey));
    return true;
  }

  readApiKey() {
    if (!fs.existsSync(this.secretPath) || !this.safeStorage.isEncryptionAvailable()) return '';
    return this.safeStorage.decryptString(fs.readFileSync(this.secretPath));
  }

  publicPaths() {
    return { configPath: this.configPath, dataDirectory: this.dir };
  }
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeAdministrators(value) {
  if (!Array.isArray(value)) return [];
  const names = new Map();
  for (const name of value) {
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name)) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].slice(0, 100);
}

function fileStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

module.exports = { ConfigStore, DEFAULT_CONFIG, normalizePort, normalizeAdministrators };
