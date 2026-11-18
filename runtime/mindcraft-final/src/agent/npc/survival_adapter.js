import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { BUILDABLE, HARVESTABLE } from './survival_build.js';

// Only ordinary, non-directional full cubes are supported by this first
// adapter. Multi-block and stateful blocks need an explicit state-aware plan.
const vec = p => new Vec3(p.x, p.y, p.z);

export class SurvivalAdapter {
    constructor(bot, dimension, pathfinder = pf) {
        if (!dimension) throw new Error('必须指定施工维度。');
        this.bot = bot;
        this.dimension = dimension;
        this.pathfinder = pathfinder;
        this.stopped = false;
    }
    check() {
        if (this.stopped || this.bot.interrupt_code) throw new Error('施工已中断。');
        if (this.bot.minebotWorldName !== this.dimension) throw new Error('伙伴所在维度与施工计划不一致，或无法验证世界标识。');
        if (this.bot.game?.gameMode !== 'survival') throw new Error('生存建造要求伙伴处于生存模式。');
        if (this.bot.health != null && this.bot.health <= 6) throw new Error('伙伴生命值过低，已暂停施工。');
    }
    async blockAt(p) { this.check(); return this.bot.blockAt(vec(p))?.name ?? null; }
    async count(name) { this.check(); return this.bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0); }
    async go(p, distance = 3) {
        this.check();
        const moves = new this.pathfinder.Movements(this.bot);
        moves.canDig = false;
        moves.allow1by1towers = false;
        moves.allowParkour = false;
        moves.canOpenDoors = false;
        moves.allowFreeMotion = false;
        moves.scafoldingBlocks = [];
        this.bot.pathfinder.setMovements(moves);
        let timer;
        try {
            await Promise.race([
                this.bot.pathfinder.goto(new this.pathfinder.goals.GoalNear(p.x, p.y, p.z, distance)),
                new Promise((_, reject) => { timer = setTimeout(() => { this.bot.pathfinder.stop(); reject(new Error('寻路超时，请检查道路。')); }, 30000); })
            ]);
        } finally { clearTimeout(timer); }
        this.check();
    }
    async collect(p) {
        this.check();
        if (!HARVESTABLE.has(p.name)) throw new Error(`暂不支持自动采集 ${p.name}。`);
        await this.go(p);
        let block = this.bot.blockAt(vec(p));
        if (!block || block.name !== p.name) throw new Error('采集目标已变化，已暂停。');
        await this.bot.tool.equipForBlock(block);
        this.check();
        block = this.bot.blockAt(vec(p));
        if (!block || block.name !== p.name || !block.canHarvest(this.bot.heldItem?.type ?? null)) throw new Error('采集目标或工具不可用。');
        await this.bot.dig(block, true);
        this.check();
        // Walk onto the vacated block, not merely next to it: item pickup has
        // a much smaller radius than the normal interaction range.
        await this.go(p, 0);
        await this.bot.waitForTicks(40);
        this.check();
    }
    async craft(source, product) {
        this.check();
        if (!HARVESTABLE.has(source) || !source.endsWith('_log') || product !== `${source.slice(0, -4)}_planks`) throw new Error('不支持该合成配方。');
        const input = this.bot.registry.itemsByName[source];
        const output = this.bot.registry.itemsByName[product];
        if (!input || !output) throw new Error('当前游戏版本不支持该材料。');
        const recipes = this.bot.recipesFor(output.id, null, 1, null);
        const recipe = recipes.find(r => {
            const ingredients = r.delta.filter(d => d.count < 0);
            return ingredients.length === 1 && ingredients[0].id === input.id && ingredients[0].count === -1;
        });
        if (!recipe) throw new Error(`无法合成 ${product}，请检查原木和配方。`);
        await this.bot.craft(recipe, 1, null);
        this.check();
    }
    async place(p) {
        this.check();
        if (!BUILDABLE.has(p.name)) throw new Error(`暂不支持自动放置 ${p.name}。`);
        await this.go(p);
        this.check();
        if (this.bot.blockAt(vec(p))?.name !== 'air') throw new Error('施工位置已被占用或未加载。');
        const item = this.bot.inventory.items().find(i => i.name === p.name);
        if (!item) throw new Error(`背包中没有 ${p.name}。`);
        const dirs = [new Vec3(0,-1,0), new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1), new Vec3(0,1,0)];
        let support, face;
        for (const dir of dirs) {
            const candidate = this.bot.blockAt(vec(p).plus(dir));
            if (candidate?.boundingBox === 'block') { support = candidate; face = dir.scaled(-1); break; }
        }
        if (!support) throw new Error('目标附近没有可支撑放置的方块。');
        await this.bot.equip(item, 'hand');
        this.check();
        if (this.bot.blockAt(vec(p))?.name !== 'air') throw new Error('施工位置已发生变化。');
        await this.bot.placeBlock(support, face);
        await this.bot.waitForTicks(5);
        this.check();
    }
    stop() { this.stopped = true; this.bot.pathfinder.stop(); this.bot.stopDigging?.(); }
}
