const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSkin, exportSkin } = require('../src/services/skin-export.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-skin-test-'));
try {
  const source = path.join(root, 'source.png');
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(64, 16); header.writeUInt32BE(64, 20);
  fs.writeFileSync(source, header);
  assert.throws(() => validateSkin(source, '../unsafe'), /游戏名称/);
  assert.throws(() => exportSkin(source, 'ExampleBot', path.join(root, 'wrong.png')), /保留文件名/);
  const target = path.join(root, 'ExampleBot.png');
  exportSkin(source, 'ExampleBot', target);
  assert.deepEqual(fs.readFileSync(target), header);
  assert.throws(() => exportSkin(source, 'ExampleBot', target), /已有同名/);
  assert.deepEqual(fs.readFileSync(target), header);
  header.writeUInt32BE(128, 16); fs.writeFileSync(source, header);
  assert.throws(() => validateSkin(source, 'ExampleBot'), /64×64/);
  console.log('skin export smoke test passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

