const fs = require('node:fs');
const path = require('node:path');

const BASE_SYSTEM_PROMPT = `你是“minebot”中同一个 AI 伙伴的管家模式。
你的任务是通过简体中文多轮对话，帮玩家把模糊想法整理成可审核的 Minecraft 施工需求。
优先了解：世界/维度、位置或坐标、长宽高、建筑风格、功能分区、材料偏好、现有地形保护、生存建造或管理员施工、允许修改的范围。
每轮最多提出 1–3 个最重要的问题，不要像问卷一样一次堆叠大量问题。
当信息足够时，输出“需求摘要”，包含目标、位置、尺寸、风格、功能、材料、保护项、待确认项和建议施工方式。
你现在只做需求澄清和方案规划，绝不声称已经修改世界、已经备份、已经获得管理员权限或已经开始施工。`;

const MODE_PROMPTS = {
  manual: `当前分支是“全手动模式”：由 AI 伙伴按普通游戏流程参与材料统计、采集、运输、地形整理和逐块搭建。方案必须包含材料清单、收集顺序、阶段划分和预计较高的对话/行为调用成本。不得建议作弊指令绕过流程。`,
  admin: `当前分支是“管理员模式”：在用户明确授权、完成备份并限定施工范围后，执行端可通过管理员桥批量放置或生成建筑，跳过材料收集。方案必须包含坐标边界、备份与回滚点、预计较低的调用成本。信息足够时，在回复末尾逐行给出可审核的 Minecraft /fill、/setblock 或 /clone 命令；每条命令必须使用明确坐标，不能使用 execute、function、op、deop、stop 或其他管理命令。不得假设权限已经授予，也不得越过用户确认直接执行。`
};

class BuildPlanner {
  constructor(dataDirectory, configStore, workbuddy) {
    this.file = path.join(dataDirectory, 'build-consultation.json');
    this.configStore = configStore;
    this.workbuddy = workbuddy;
    this.busy = false;
  }

  load() {
    const record = this.readRecord();
    return projectState(record);
  }

  save(state) {
    const record = this.readRecord();
    const mode = normalizeMode(state.mode);
    record.mode = mode;
    record.conversations[mode] = Array.isArray(state.messages) ? state.messages.slice(-100) : [];
    record.updatedAt = new Date().toISOString();
    return this.writeRecord(record);
  }

  readRecord() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const mode = normalizeMode(parsed.mode);
      const conversations = parsed.conversations && typeof parsed.conversations === 'object'
        ? parsed.conversations
        : { manual: mode === 'manual' && Array.isArray(parsed.messages) ? parsed.messages : [], admin: mode === 'admin' && Array.isArray(parsed.messages) ? parsed.messages : [] };
      return { mode, conversations: { manual: Array.isArray(conversations.manual) ? conversations.manual.slice(-100) : [], admin: Array.isArray(conversations.admin) ? conversations.admin.slice(-100) : [] }, updatedAt: parsed.updatedAt || null };
    } catch {
      const configured = this.configStore.load().behavior.buildStewardMode;
      return { mode: normalizeMode(configured), conversations: { manual: [], admin: [] }, updatedAt: null };
    }
  }

  writeRecord(record) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
    return projectState(record);
  }

  clear() {
    const current = this.load();
    return this.save({ mode: current.mode, messages: [] });
  }

  setMode(mode) {
    const normalized = normalizeMode(mode);
    const record = this.readRecord();
    record.mode = normalized;
    record.updatedAt = new Date().toISOString();
    const config = this.configStore.load();
    config.behavior.buildStewardMode = normalized;
    this.configStore.save(config);
    return this.writeRecord(record);
  }

  adminCommands() {
    const state = this.load();
    if (state.mode !== 'admin') throw new Error('请先切换到管理员模式。');
    const latest = [...state.messages].reverse().find((message) => message.role === 'assistant');
    if (!latest) throw new Error('请先让伙伴生成包含命令预览的施工方案。');
    const commands = [...String(latest.content).matchAll(/\/(?:fill|setblock|clone)\s+[^\r\n`]+/gi)]
      .map((match) => match[0].trim().replace(/[。；;]+$/, ''));
    return [...new Set(commands)].slice(0, 64);
  }

  async send(text) {
    const content = String(text || '').trim();
    if (!content) throw new Error('请先输入建造需求。');
    if (content.length > 12000) throw new Error('单次输入过长，请拆分或保持在 12000 字以内。');
    if (this.busy) throw new Error('伙伴正在思考上一条需求。');
    const state = this.load();
    state.messages.push({ role: 'user', content, at: new Date().toISOString() });
    this.save(state);
    this.busy = true;
    try {
      const reply = await this.complete(state.messages, state.mode);
      state.messages.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
      return this.save(state);
    } finally {
      this.busy = false;
    }
  }

  async survivalBlueprint() {
    const state = this.load();
    if (state.mode !== 'manual') throw new Error('请先选择生存建造。');
    if (!state.messages.some(message => message.role === 'user')) throw new Error('请先在对话中说明建筑、坐标和允许采集的方块。');
    if (this.busy) throw new Error('伙伴正在思考，请稍后再试。');
    this.busy = true;
    try {
      const request = `根据上面的对话生成可审阅的生存施工 JSON。只输出 JSON，不要代码围栏或解释。格式：{"dimension":"minecraft:overworld","bounds":{"min":{"x":0,"y":64,"z":0},"max":{"x":1,"y":64,"z":0}},"blocks":[{"x":0,"y":64,"z":0,"name":"dirt"}],"sources":[{"x":5,"y":64,"z":0,"name":"oak_log","product":"oak_planks"}]}。bounds 是施工范围，blocks 是每个要放置的方块，sources 是用户明确允许采集的具体坐标；sources 可为空，只用伙伴背包中现有材料。只能使用普通方块 dirt、cobblestone、stone、oak_planks、spruce_planks、birch_planks、jungle_planks、acacia_planks、dark_oak_planks、bricks、stone_bricks；采集只能使用 dirt、cobblestone 和以上各木种的 _log，原木可合成对应 _planks。每个坐标必须是整数，最多 512 个施工方块，施工范围每个方向最多 33 格，采集坐标不能在施工范围内。不得添加箱子、门、床、楼梯、空气或模组方块，不得生成指令，不得自行猜测玩家没有明确提供的施工位置、维度和采集位置。若信息不足或无法用这些方块表达，输出 {"error":"具体说明缺少的信息或不支持的内容"}。`;
      const scanRequest = `${request}\n如果用户明确给出允许采集的矩形区域两角坐标，可以附加 harvestAreas:[{"min":{"x":1,"y":64,"z":1},"max":{"x":4,"y":68,"z":4}}]，由已进入游戏的伙伴只读扫描这些区域，再显示具体候选方块供用户确认。每个方向最多 33 格，总体积最多 32768 方块。没有用户明确给出的区域时不要填写或猜测。`;
      const response = await this.complete([...state.messages, { role: 'user', content: scanRequest }], 'manual');
      const stripped = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      let parsed;
      try { parsed = JSON.parse(stripped); } catch { throw new Error('伙伴没有返回有效的施工 JSON，请补充明确坐标后重试。'); }
      if (parsed?.error) throw new Error(String(parsed.error).slice(0, 600));
      return parsed;
    } finally { this.busy = false; }
  }

  async complete(history, mode) {
    const config = this.configStore.load();
    const messages = [
      { role: 'system', content: `${BASE_SYSTEM_PROMPT}\n${MODE_PROMPTS[normalizeMode(mode)]}` },
      ...history.slice(-30).map(({ role, content }) => ({ role, content }))
    ];
    if (config.model.channel === 'workbuddy') {
      if (!config.model.workbuddyModel) throw new Error('请先在主窗口选择 WorkBuddy 模型。');
      const gateway = await this.workbuddy.startGateway();
      const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.token}` },
        body: JSON.stringify({ model: config.model.workbuddyModel, messages, stream: true })
      });
      return parseModelResponse(response);
    }
    const apiKey = this.configStore.readApiKey();
    if (!config.model.baseUrl || !config.model.modelId || !apiKey) {
      throw new Error('请先在主窗口完成 API 地址、模型名称和 API Key 配置。');
    }
    const endpoint = chatEndpoint(config.model.baseUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: config.model.modelId, messages, stream: false })
    });
    return parseModelResponse(response);
  }
}

function normalizeMode(mode) {
  return mode === 'admin' ? 'admin' : 'manual';
}

function projectState(record) {
  const mode = normalizeMode(record.mode);
  return { mode, messages: record.conversations[mode].slice(-100), updatedAt: record.updatedAt || null };
}

function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

async function parseModelResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 400);
    try { message = JSON.parse(text)?.error?.message || message; } catch {}
    throw new Error(`模型请求失败：${message || response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '');
  if (contentType.includes('text/event-stream') || text.startsWith('data:')) {
    let output = '';
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        output += json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || '';
      } catch {}
    }
    if (output.trim()) return output.trim();
  }
  try {
    const json = JSON.parse(text);
    const output = json.choices?.[0]?.message?.content || json.output_text || '';
    if (String(output).trim()) return String(output).trim();
  } catch {}
  throw new Error('模型返回了无法识别的内容。');
}

module.exports = { BuildPlanner };
