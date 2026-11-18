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
    const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:MINEBOT_TEST_PACK, $env:MINEBOT_TEST_ARCHIVE)'], {
      windowsHide: true, env: { ...process.env, MINEBOT_TEST_PACK: pack, MINEBOT_TEST_ARCHIVE: archive }
    });
    const manager = new ArchiveManager(path.join(root, 'profile'), inspectInstance);
    const first = await manager.prepare(archive);
    assert.equal(first.reused, false);
    assert.equal(first.inspection.minecraftVersion, '1.20.1');
    assert.equal(first.inspection.modLoader, 'forge');
    assert.equal(first.inspection.worlds.length, 1);
    const second = await manager.prepare(archive);
    assert.equal(second.reused, true);
    assert.throws(() => validateArchiveEntries(['../escape.txt']), /不安全路径/);
    for (const entry of ['mods/file:stream', 'mods/NUL.jar', 'mods/foo. /file', 'C:/escape', '/escape']) assert.throws(() => validateArchiveEntries([entry]), /不安全路径/);
    const malicious = path.join(root, 'linked.zip');
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::Open($env:MINEBOT_TEST_ARCHIVE, "Create"); $entry=$zip.CreateEntry("mods/link"); $entry.ExternalAttributes=-1577058304; $zip.Dispose()'], {
      windowsHide: true, env: { ...process.env, MINEBOT_TEST_ARCHIVE: malicious }
    });
    await assert.rejects(manager.prepare(malicious), /符号链接|链接或特殊文件/);
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
