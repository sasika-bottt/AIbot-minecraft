const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ArchiveManager, validateArchiveEntries, validateExtractedTree } = require('../src/services/archive-manager.cjs');
const { inspectInstance } = require('../src/services/detector.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingban-archive-'));
  try {
    const pack = path.join(root, 'pack');
    fs.mkdirSync(path.join(pack, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(pack, 'config'), { recursive: true });
    fs.mkdirSync(path.join(pack, 'saves', '测试世界'), { recursive: true });
    fs.writeFileSync(path.join(pack, 'mods', 'example.jar'), 'mod');
    fs.writeFileSync(path.join(pack, 'saves', '测试世界', 'level.dat'), 'world');
    fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({ minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.23', primary: true }] } }));
    const archive = path.join(root, 'pack.zip');
    const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar.exe';
    execFileSync(tar, ['-a', '-cf', archive, '-C', pack, '.'], { windowsHide: true });
    const manager = new ArchiveManager(path.join(root, 'profile'), inspectInstance);
    const first = await manager.prepare(archive);
    assert.equal(first.reused, false);
    assert.equal(first.inspection.minecraftVersion, '1.20.1');
    assert.equal(first.inspection.modLoader, 'forge');
    assert.equal(first.inspection.worlds.length, 1);
    const second = await manager.prepare(archive);
    assert.equal(second.reused, true);
    assert.throws(() => validateArchiveEntries(['../escape.txt']), /不安全路径/);
    const safeTree = validateExtractedTree(first.root);
    assert.ok(safeTree.files >= 3);
    console.log('archive import smoke test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

