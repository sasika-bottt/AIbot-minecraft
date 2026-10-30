// A deliberately narrow execution core for survival construction.  It accepts
// explicit block coordinates only; it never generates or executes commands.
const NAME = /^[a-z0-9_]{1,64}$/;
const LOGS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak']);
export const BUILDABLE = new Set(['dirt', 'cobblestone', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'bricks', 'stone_bricks']);
export const HARVESTABLE = new Set(['dirt', 'cobblestone', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log']);
const key = p => `${p.x},${p.y},${p.z}`;
const inside = (p, b) => ['x', 'y', 'z'].every(k => p[k] >= b.min[k] && p[k] <= b.max[k]);

function point(p) {
    if (!p || !['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)) throw new Error('坐标必须为有效整数。');
    return { x: p.x, y: p.y, z: p.z };
}

export function validateSurvivalPlan(input) {
    if (!input || typeof input !== 'object') throw new Error('施工计划无效。');
    const min = point(input.bounds?.min), max = point(input.bounds?.max);
    if (['x', 'y', 'z'].some(k => min[k] > max[k] || max[k] - min[k] > 32)) throw new Error('施工范围无效或超过限制。');
    const bounds = { min, max };
    if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 512) throw new Error('施工方块数量必须为 1–512。');
    const occupied = new Set();
    const blocks = input.blocks.map(b => {
        const pos = point(b);
        if (!inside(pos, bounds) || occupied.has(key(pos))) throw new Error('施工方块超出范围或坐标重复。');
        if (typeof b.name !== 'string' || !NAME.test(b.name) || !BUILDABLE.has(b.name)) throw new Error('暂不支持该施工材料。');
        occupied.add(key(pos));
        return { ...pos, name: b.name };
    });
    if (!Array.isArray(input.sources) || input.sources.length > 2048) throw new Error('采集坐标列表无效。');
    const seen = new Set();
    const sources = input.sources.map(s => {
        const pos = point(s);
        if (inside(pos, bounds) || seen.has(key(pos))) throw new Error('采集坐标不得与施工区重叠或重复。');
        if (typeof s.name !== 'string' || !NAME.test(s.name) || !HARVESTABLE.has(s.name)) throw new Error('暂不支持该采集材料。');
        const product = s.product || s.name;
        const wood = s.name.endsWith('_log') ? s.name.slice(0, -4) : '';
        if (product !== s.name && !(LOGS.has(wood) && product === `${wood}_planks`)) throw new Error('不支持该采集与合成组合。');
        seen.add(key(pos));
        return { ...pos, name: s.name, product };
    });
    return { bounds, blocks, sources };
}

// World state and inventory, rather than a saved cursor, are the source of
// truth after a restart. This prevents duplicate placements or blind digging.
export class SurvivalBuild {
    constructor(plan, adapter, save = async () => {}) {
        this.plan = validateSurvivalPlan(plan);
        this.adapter = adapter;
        this.save = save;
        this.cancelled = false;
        this.running = false;
        this.status = { phase: 'ready', completed: 0, total: this.plan.blocks.length, message: '等待开始。' };
    }
    async update(phase, message, completed = this.status.completed) {
        this.status = { phase, message, completed, total: this.plan.blocks.length };
        await this.save({ plan: this.plan, status: this.status });
    }
    stop() { this.cancelled = true; this.adapter.stop?.(); }
    async run() {
        if (this.running) throw new Error('已有施工任务正在运行。');
        this.running = true;
        this.cancelled = false;
        try {
            let completed = 0;
            // Refuse the entire job before collecting anything if an existing
            // block would need replacing or a target chunk is not loaded.
            for (const target of this.plan.blocks) {
                if (this.cancelled) return await this.update('paused', '施工已暂停。', completed);
                const actual = await this.adapter.blockAt(target);
                if (actual !== 'air' && actual !== target.name) throw new Error(`施工位置 ${key(target)} 被 ${actual || '未加载的方块'} 占用；请检查后继续。`);
            }
            for (const target of this.plan.blocks) {
                if (this.cancelled) return await this.update('paused', '施工已暂停。', completed);
                let actual = await this.adapter.blockAt(target);
                if (actual === target.name) { completed++; continue; }
                if (actual !== 'air') throw new Error(`施工位置 ${key(target)} 被 ${actual || '未加载的方块'} 占用；请检查后继续。`);
                if (await this.adapter.count(target.name) < 1) {
                    await this.update('collecting', `正在寻找 ${target.name}。`, completed);
                    let collected = false;
                    for (const source of this.plan.sources.filter(s => s.product === target.name)) {
                        if (this.cancelled) return await this.update('paused', '施工已暂停。', completed);
                        if (source.product !== source.name && await this.adapter.count(source.name) > 0) {
                            await this.adapter.craft(source.name, source.product);
                            if (await this.adapter.count(target.name) > 0) { collected = true; break; }
                            throw new Error(`无法将 ${source.name} 合成为 ${target.name}。`);
                        }
                        if (await this.adapter.blockAt(source) !== source.name) continue;
                        await this.adapter.collect(source);
                        if (source.product !== source.name) await this.adapter.craft(source.name, source.product);
                        if (await this.adapter.count(target.name) > 0) { collected = true; break; }
                        throw new Error(`采集 ${target.name} 后未获得材料；已停止以避免继续消耗资源。`);
                    }
                    if (!collected) throw new Error(`无法取得 ${target.name}；请检查采集区、工具和背包。`);
                }
                if (this.cancelled) return await this.update('paused', '施工已暂停。', completed);
                actual = await this.adapter.blockAt(target);
                if (actual === target.name) { completed++; continue; }
                if (actual !== 'air') throw new Error(`施工位置 ${key(target)} 已发生变化；已暂停。`);
                await this.update('building', `正在施工：${key(target)}。`, completed);
                await this.adapter.place(target);
                if (await this.adapter.blockAt(target) !== target.name) throw new Error(`无法确认 ${key(target)} 的施工结果。`);
                completed++;
                await this.update('building', `已完成 ${completed}/${this.plan.blocks.length}。`, completed);
            }
            await this.update('completed', '已核验所有施工方块。', completed);
        } catch (error) {
            await this.update(this.cancelled ? 'paused' : 'blocked', this.cancelled ? '施工已暂停。' : String(error.message || error));
        } finally { this.running = false; }
    }
}
