import assert from 'node:assert/strict';
import { SurvivalBuild, validateSurvivalPlan } from '../runtime/mindcraft-final/src/agent/npc/survival_build.js';
import { SurvivalAdapter } from '../runtime/mindcraft-final/src/agent/npc/survival_adapter.js';

const p = (x, y, z, name) => ({x, y, z, name});
const plan = { bounds: { min: p(0, 0, 0), max: p(2, 1, 0) }, blocks: [p(0, 0, 0, 'dirt'), p(1, 0, 0, 'dirt')], sources: [p(5, 0, 0, 'dirt'), p(6, 0, 0, 'dirt')] };
const k = pos => `${pos.x},${pos.y},${pos.z}`;
function world() {
  const blocks = new Map([['5,0,0', 'dirt'], ['6,0,0', 'dirt']]);
  const inventory = new Map();
  return {
    blocks, inventory,
    async blockAt(pos) { return blocks.get(k(pos)) || 'air'; },
    async count(name) { return inventory.get(name) || 0; },
    async collect(pos) { assert.equal(blocks.get(k(pos)), pos.name); blocks.delete(k(pos)); inventory.set(pos.name, (inventory.get(pos.name) || 0) + 1); },
    async place(pos) { assert.equal(blocks.get(k(pos)), undefined); assert.ok(inventory.get(pos.name) > 0); inventory.set(pos.name, inventory.get(pos.name) - 1); blocks.set(k(pos), pos.name); }
  };
}
assert.throws(() => validateSurvivalPlan({ ...plan, sources: [p(0,0,0,'dirt')] }), /采集坐标/);
assert.throws(() => validateSurvivalPlan({ ...plan, blocks: [plan.blocks[0], plan.blocks[0]] }), /坐标重复/);
assert.throws(() => validateSurvivalPlan({ ...plan, blocks: [p(9,0,0,'dirt')] }), /超出范围/);
assert.throws(() => validateSurvivalPlan({ ...plan, sources: [p(5,0,0,'oak_log')].map(s => ({...s, product:'diamond'})) }), /组合/);
const a = world(); const snapshots = [];
const build = new SurvivalBuild(plan, a, async s => snapshots.push(s.status.phase));
await build.run();
assert.equal(build.status.phase, 'completed');
assert.equal(build.status.completed, 2);
assert.deepEqual([a.blocks.get('0,0,0'), a.blocks.get('1,0,0')], ['dirt', 'dirt']);
assert.ok(snapshots.includes('collecting') && snapshots.includes('building'));
await new SurvivalBuild(plan, a).run();
assert.equal(a.inventory.get('dirt'), 0, 'resume must not mine again');
const b = world(); b.blocks.set('0,0,0', 'chest');
const blocked = new SurvivalBuild(plan, b); await blocked.run();
assert.equal(blocked.status.phase, 'blocked'); assert.equal(b.blocks.get('0,0,0'), 'chest');
assert.equal(b.blocks.get('5,0,0'), 'dirt');
const c = world(); const paused = new SurvivalBuild(plan, c);
const original = c.place; c.place = async pos => { await original(pos); paused.stop(); };
await paused.run(); assert.equal(paused.status.phase, 'paused');
c.place = original; const resumed = new SurvivalBuild(plan, c); await resumed.run();
assert.equal(resumed.status.phase, 'completed');
const d = world(); d.collect = async pos => { d.blocks.delete(k(pos)); }; // source does not drop the required item
const missing = new SurvivalBuild(plan, d); await missing.run();
assert.equal(missing.status.phase, 'blocked'); assert.match(missing.status.message, /未获得材料/);
assert.equal(d.blocks.get('6,0,0'), 'dirt', 'must stop after an unsuccessful collection');
const woodPlan = { ...plan, blocks: [p(0,0,0,'oak_planks'), p(1,0,0,'oak_planks')], sources: [{...p(5,0,0,'oak_log'),product:'oak_planks'}] };
const wood = world(); wood.blocks.set('5,0,0','oak_log');
wood.craft = async (source, product) => { assert.equal(source,'oak_log'); assert.equal(product,'oak_planks'); wood.inventory.set(source,wood.inventory.get(source)-1); wood.inventory.set(product,4); };
const woodBuild = new SurvivalBuild(woodPlan, wood); await woodBuild.run();
assert.equal(woodBuild.status.phase,'completed'); assert.equal(wood.inventory.get('oak_planks'),2);
let movement, placed = 0, dug = 0;
const fakePf = { Movements: class {}, goals: { GoalNear: class { constructor(x,y,z,r) { Object.assign(this, {x,y,z,r}); } } } };
const mockBot = {
  minebotWorldName: 'minecraft:overworld',
  game: { dimension: 'minecraft:overworld', gameMode: 'survival' }, health: 20,
  inventory: { items: () => [{ name: 'dirt', count: 2 }] },
  pathfinder: { setMovements: m => { movement = m; }, goto: async () => {}, stop() {} },
  blockAt(pos) { if (pos.x === 0 && pos.y === -1 && pos.z === 0) return { name: 'stone', boundingBox: 'block' }; return { name: 'air' }; },
  equip: async () => {}, placeBlock: async () => { placed++; }, waitForTicks: async () => {},
  tool: { equipForBlock: async () => {} }, dig: async () => { dug++; }
};
const adapter = new SurvivalAdapter(mockBot, 'minecraft:overworld', fakePf);
await adapter.place(p(0, 0, 0, 'dirt'));
assert.equal(placed, 1); assert.equal(movement.canDig, false); assert.equal(movement.allow1by1towers, false);
assert.equal(movement.canOpenDoors, false); assert.equal(movement.allowParkour, false);
await assert.rejects(() => adapter.place(p(0,0,0,'chest')), /暂不支持/);
await assert.rejects(() => adapter.collect(p(3,0,0,'chest')), /暂不支持/);
assert.equal(dug, 0);
mockBot.minebotWorldName = 'minecraft:the_nether';
await assert.rejects(() => adapter.place(p(0,0,0,'dirt')), /维度/);
mockBot.minebotWorldName = 'minecraft:overworld'; mockBot.health = 6;
await assert.rejects(() => adapter.place(p(0,0,0,'dirt')), /生命值/);
console.log('survival build safety smoke test passed');
