import { SurvivalBuild, validateSurvivalPlan } from './survival_build.js';
import { SurvivalAdapter } from './survival_adapter.js';
import Vec3 from 'vec3';

export class SurvivalController {
    constructor(agent) { this.agent = agent; this.build = null; this.pending = false; }
    status() { return this.build?.status || { phase: 'idle', message: '尚无生存施工任务。', completed: 0, total: 0 }; }
    scan(raw, dimension, areas) {
        if (dimension !== this.agent.bot.minebotWorldName) throw new Error('伙伴所在世界与计划不一致。');
        const plan = validateSurvivalPlan(raw);
        if (!Array.isArray(areas) || areas.length > 4) throw new Error('采集范围最多为 4 个。');
        const point = p => p && ['x','y','z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000);
        let volume = 0;
        for (const area of areas) {
            if (!point(area?.min) || !point(area?.max) || ['x','y','z'].some(k => area.min[k] > area.max[k] || area.max[k] - area.min[k] > 32)) throw new Error('采集范围的坐标无效或超过 33 格。');
            volume += ['x','y','z'].reduce((n,k) => n * (area.max[k] - area.min[k] + 1), 1);
        }
        if (volume > 32768) throw new Error('采集范围过大，请缩小到 32768 个方块以内。');
        const needed = new Map();
        for (const b of plan.blocks) needed.set(b.name, (needed.get(b.name) || 0) + 1);
        const sourceFor = name => name.endsWith('_planks') ? `${name.slice(0,-7)}_log` : ['dirt','cobblestone'].includes(name) ? name : null;
        const sourceNames = new Map([...needed].map(([product,count]) => [sourceFor(product), { product, count: product.endsWith('_planks') ? Math.ceil(count / 4) : count }]).filter(([name]) => name));
        const found = [], seen = new Set(plan.sources.map(p => `${p.x},${p.y},${p.z}`));
        let unloaded = 0;
        for (const area of areas) for (let x=area.min.x; x<=area.max.x; x++) for (let y=area.min.y; y<=area.max.y; y++) for (let z=area.min.z; z<=area.max.z; z++) {
            if (['x','y','z'].every(k => ({x,y,z})[k] >= plan.bounds.min[k] && ({x,y,z})[k] <= plan.bounds.max[k])) continue;
            const pos = {x,y,z}, key = `${x},${y},${z}`;
            if (seen.has(key)) continue;
            const block = this.agent.bot.blockAt(new Vec3(x,y,z));
            if (!block) { unloaded++; continue; }
            const spec = sourceNames.get(block.name);
            if (!spec || spec.count <= 0) continue;
            spec.count--; seen.add(key);
            found.push({ ...pos, name:block.name, product:spec.product });
        }
        return { sources:found, unloaded };
    }
    start(plan, dimension) {
        if (this.pending || this.build?.running || !this.agent.isIdle()) throw new Error('伙伴正在执行其他任务，请稍后再试。');
        if (dimension !== this.agent.bot.minebotWorldName) throw new Error(`伙伴所在世界与施工计划不一致，或游戏没有提供可验证的世界标识（当前：${String(this.agent.bot.minebotWorldName)}）。`);
        const validated = validateSurvivalPlan(plan);
        this.pending = true;
        this.abortBeforeStart = false;
        const build = new SurvivalBuild(validated, new SurvivalAdapter(this.agent.bot, dimension));
        this.build = build;
        // Claim the existing agent action manager; there is no second game bot.
        this.agent.actions.runAction('survival-build', async () => {
            if (this.abortBeforeStart) { build.status = { ...build.status, phase: 'paused', message: '施工已暂停。' }; return; }
            await build.run();
        }, { timeout: 0 })
            .then(result => {
                if ((!result.success || result.interrupted || result.timedout) && build.status.phase !== 'completed') {
                    build.status = { ...build.status, phase: 'paused', message: '伙伴的施工动作被中断，请检查后继续。' };
                }
            })
            .catch(error => { build.status = { ...build.status, phase: 'blocked', message: String(error.message || error) }; })
            .finally(() => { this.pending = false; });
        return { ...build.status, phase: 'starting', message: '伙伴正在准备施工。' };
    }
    stop() {
        if (!this.build || (!this.pending && !this.build.running)) return this.status();
        if (!this.build.running) this.abortBeforeStart = true;
        this.build.stop();
        return { ...this.status(), message: '正在暂停施工。' };
    }
}
