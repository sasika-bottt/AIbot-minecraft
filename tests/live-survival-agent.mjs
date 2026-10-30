// Only launched by the isolated live-survival-build test, never by the app.
import { setSettings } from '../runtime/mindcraft-final/src/agent/settings.js';
import { initBot } from '../runtime/mindcraft-final/src/utils/mcdata.js';
import { SurvivalBuild } from '../runtime/mindcraft-final/src/agent/npc/survival_build.js';
import { SurvivalAdapter } from '../runtime/mindcraft-final/src/agent/npc/survival_adapter.js';
setSettings({ minecraft_version: '1.20.1', forge_server: true, host: '127.0.0.1', port: 25575, auth: 'offline' });
const bot = initBot('MinebotBuildTest');
bot.once('error', e => { console.error(e.message); process.exitCode = 1; });
bot.once('spawn', async () => {
  console.log('MINEBOT_TEST_SPAWNED');
  await new Promise(resolve => process.stdin.once('data', resolve));
  try {
    await bot.waitForTicks(40);
    const dimension = bot.minebotWorldName;
    const p = (x,y,z,name) => ({x,y,z,name});
    const plan = { bounds: { min: p(4,100,4), max: p(5,100,4) }, blocks: [p(4,100,4,'dirt'), p(5,100,4,'dirt')], sources: [p(6,100,4,'dirt'), p(7,100,4,'dirt')] };
    let build;
    build = new SurvivalBuild(plan, new SurvivalAdapter(bot, dimension), async snapshot => {
      if (snapshot.status.phase === 'building' && snapshot.status.completed === 1) build.stop();
    });
    await build.run();
    if (build.status.phase !== 'paused' || build.status.completed !== 1) throw new Error(`暂停验证失败：${build.status.message}`);
    const resumed = new SurvivalBuild(plan, new SurvivalAdapter(bot, dimension));
    await resumed.run();
    if (resumed.status.phase !== 'completed' || resumed.status.completed !== 2) throw new Error(resumed.status.message);
    const woodPlan = { bounds: { min: p(4,100,6), max: p(5,100,6) }, blocks: [p(4,100,6,'oak_planks'), p(5,100,6,'oak_planks')], sources: [{ ...p(9,100,4,'oak_log'), product: 'oak_planks' }] };
    const woodBuild = new SurvivalBuild(woodPlan, new SurvivalAdapter(bot, dimension));
    await woodBuild.run();
    if (woodBuild.status.phase !== 'completed') throw new Error(`木板施工：${woodBuild.status.message}`);
    const protectedPlan = { bounds: { min: p(7,100,6), max: p(8,100,6) }, blocks: [p(7,100,6,'dirt'), p(8,100,6,'dirt')], sources: [p(11,100,4,'dirt')] };
    const safe = new SurvivalAdapter(bot, dimension);
    const protectedBuild = new SurvivalBuild(protectedPlan, safe);
    await protectedBuild.run();
    if (protectedBuild.status.phase !== 'blocked' || await safe.blockAt(p(8,100,6)) !== 'chest' || await safe.blockAt(p(11,100,4)) !== 'dirt') throw new Error('障碍保护验证失败。');
    console.log('MINEBOT_TEST_COMPLETED');
  } catch (e) { console.error(`MINEBOT_TEST_FAILED: ${e.message}`); process.exitCode = 1; }
  finally { bot.quit(); setTimeout(() => process.exit(process.exitCode || 0), 1000); }
});
