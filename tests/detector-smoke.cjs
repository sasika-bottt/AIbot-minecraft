const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectInstance, expectedJavaMajor, selectJavaForVersion } = require('../src/services/detector.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingban-detector-'));
try {
  const minecraft = path.join(root, '.minecraft');
  const version = path.join(minecraft, 'versions', 'Forge-1.20.1');
  fs.mkdirSync(version, { recursive: true });
  fs.mkdirSync(path.join(minecraft, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(minecraft, 'saves', '世界A'), { recursive: true });
  fs.writeFileSync(path.join(minecraft, 'saves', '世界A', 'level.dat'), 'world');
  fs.writeFileSync(path.join(minecraft, 'mods', 'example.jar'), 'mod');
  fs.writeFileSync(path.join(version, 'Forge-1.20.1.json'), JSON.stringify({
    id: 'Forge-1.20.1',
    inheritsFrom: '1.20.1',
    javaVersion: { majorVersion: 17 },
    libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.4.23' }]
  }));
  const inspected = inspectInstance(version);
  assert.equal(inspected.contentRoot, minecraft);
  assert.equal(inspected.minecraftVersion, '1.20.1');
  assert.equal(inspected.modLoader, 'forge');
  assert.equal(inspected.loaderVersion, '1.20.1-47.4.23');
  assert.equal(inspected.javaMajor, 17);
  assert.equal(inspected.worlds.length, 1);
  assert.equal(expectedJavaMajor('1.16.5'), 8);
  assert.equal(expectedJavaMajor('1.20.1'), 17);
  assert.equal(expectedJavaMajor('1.20.6'), 21);
  assert.equal(selectJavaForVersion([{ major: 8, path: 'java8' }, { major: 17, path: 'java17' }], '1.20.1').selected.path, 'java17');
  console.log('detector and Java matching smoke test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
