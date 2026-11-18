import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pickupNearbyItems } from '../runtime/mindcraft-final/src/agent/library/skills.js';

const require = createRequire(new URL('../runtime/mindcraft-final/package.json', import.meta.url));
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.21.11');

async function run(collect) {
  const item = { name: 'item', position: new Vec3(1.2, 64, 2.7) };
  let present = true;
  let count = 0;
  let movement;
  const bot = {
    registry,
    output: '',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => count ? [{ count }] : [] },
    nearestEntity: predicate => present && predicate(item) ? item : null,
    pathfinder: {
      setMovements(value) { movement = value; },
      async goto(goal) {
        assert.deepEqual([goal.x, goal.y, goal.z], [1, 64, 2]);
        if (collect) { present = false; count = 1; }
      }
    }
  };
  const result = await pickupNearbyItems(bot);
  assert.equal(result, collect);
  assert.equal(movement.canDig, false);
  assert.deepEqual(movement.scafoldingBlocks, []);
  assert.match(bot.output, collect ? /Picked up 1 items/ : /Picked up 0 items/);
}

await run(true);
await run(false);
console.log('dropped item pickup movement and failure smoke test passed');
