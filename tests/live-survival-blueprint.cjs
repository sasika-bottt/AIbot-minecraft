// Opt-in real WorkBuddy request with a synthetic, non-user plan.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BuildPlanner } = require('../src/services/build-planner.cjs');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');
async function main() {
  const profile = process.argv[2]; if (!profile) throw new Error('需要临时测试配置目录。');
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-blueprint-test-'));
  const workbuddy = new WorkBuddyService(root);
  const planner = new BuildPlanner(root, {load: () => config, save: () => {}, readApiKey: () => ''}, workbuddy);
  try {
    planner.save({mode:'manual',messages:[{role:'user',content:'在主世界坐标 x=4 y=100 z=4 放置 1 个泥土方块。允许采集点只有 x=6 y=100 z=4 的泥土方块。'}]});
    const raw = await planner.survivalBlueprint();
    const {validateSurvivalPlan} = await import(pathToFileURL(path.join(__dirname,'../runtime/mindcraft-final/src/agent/npc/survival_build.js')).href);
    const plan = validateSurvivalPlan(raw);
    if (raw.dimension !== 'minecraft:overworld' || plan.blocks.length !== 1 || plan.blocks[0].x !== 4 || plan.blocks[0].y !== 100 || plan.blocks[0].z !== 4 || plan.sources.length !== 1 || plan.sources[0].x !== 6 || plan.sources[0].y !== 100 || plan.sources[0].z !== 4) throw new Error('模型生成的坐标与测试需求不一致。');
    planner.save({mode:'manual',messages:[{role:'user',content:'在主世界坐标 x=4 y=100 z=4 放置 1 个泥土方块，允许采集区域的两个角是 x=6 y=100 z=4 和 x=7 y=100 z=4，请扫描区域。'}]});
    const scanPlan = await planner.survivalBlueprint();
    const area = scanPlan.harvestAreas?.[0];
    if (!area || area.min?.x !== 6 || area.max?.x !== 7 || area.min?.y !== 100 || area.max?.y !== 100 || area.min?.z !== 4 || area.max?.z !== 4) throw new Error('模型没有按要求生成采集范围。');
    console.log('WorkBuddy 模型生成的简单施工计划和采集范围通过校验。');
  } finally { await workbuddy.stopGateway(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
