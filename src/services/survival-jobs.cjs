const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class SurvivalJobs {
  constructor(directory, server, bot, validate) {
    this.file = path.join(directory, 'survival-job.json');
    this.server = server; this.bot = bot; this.validator = validate; this.busy = false;
  }
  async normalize(raw) {
    if (!raw || !['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'].includes(raw.dimension)) throw new Error('请明确选择主世界、下界或末地。');
    const validate = this.validator || (await import(pathToFileURL(path.join(this.bot.project, 'src/agent/npc/survival_build.js')).href)).validateSurvivalPlan;
    return { dimension: raw.dimension, ...validate(raw) };
  }
  load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  async preview(raw) {
    const plan = await this.normalize(raw);
    if (raw.harvestAreas === undefined) return plan;
    if (!Array.isArray(raw.harvestAreas)) throw new Error('采集范围格式无效。');
    if (!raw.harvestAreas.length) return plan;
    const result = await this.bot.survivalRequest({ action:'scan', plan, dimension:plan.dimension, areas:raw.harvestAreas });
    const normalized = await this.normalize({ ...plan, sources:[...plan.sources, ...result.sources] });
    return { ...normalized, harvestAreas:raw.harvestAreas, scanUnloaded:result.unloaded };
  }
  save(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8'); fs.renameSync(tmp, this.file);
  }
  async status() {
    const job = this.load();
    try { return { job, agent: await this.bot.survivalRequest({ action: 'status' }) }; }
    catch { return { job, agent: { phase: 'offline', message: '伙伴未连接；保存的计划不会自动继续。' } }; }
  }
  async start(raw) {
    if (this.busy) throw new Error('正在准备另一项施工任务。');
    this.busy = true;
    try {
      const plan = await this.normalize(raw);
      const server = this.server.status();
      if (!server.ready || !server.serverDirectory) throw new Error('请先启动服务器。');
      const current = await this.bot.survivalRequest({ action: 'status' });
      if (['starting', 'ready', 'building', 'collecting'].includes(current.phase)) throw new Error('伙伴已有施工任务，请先暂停。');
      const backup = await this.server.backupForSurvivalBuild();
      if (!this.server.status().ready || this.server.status().serverDirectory !== server.serverDirectory) throw new Error('服务器已变化，备份保留，未开始施工。');
      const job = { plan, worldDirectory: path.resolve(server.serverDirectory, 'world'), backup, updatedAt: new Date().toISOString() };
      this.save(job);
      const agent = await this.bot.survivalRequest({ action: 'start', plan, dimension: plan.dimension });
      return { job, agent };
    } finally { this.busy = false; }
  }
  async resume() {
    const job = this.load();
    if (!job) throw new Error('没有保存的施工计划。');
    const server = this.server.status();
    const continuation = this.server.isWorldContinuation
      ? this.server.isWorldContinuation(job.worldDirectory)
      : path.resolve(server.serverDirectory || '', 'world') === job.worldDirectory;
    if (!server.ready || !continuation) throw new Error('当前服务器世界与保存的施工计划不一致，不能继续。');
    return this.start(job.plan);
  }
  async stop() { return this.bot.survivalRequest({ action: 'stop' }); }
}
module.exports = { SurvivalJobs };
