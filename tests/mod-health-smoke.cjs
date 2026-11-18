const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const { inspectMods, prepareModDependencies } = require('../src/services/mod-health.cjs');
const { probeServer, varInt } = require('../src/services/server-probe.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-mod-health-'));
const originalFetch = global.fetch;
const hash = value => crypto.createHash('sha512').update(value).digest('hex');
async function main() {
  const fixtures = path.join(root, 'fixtures'); fs.mkdirSync(fixtures);
  for (const [name, metadata] of Object.entries({ parent: { id: 'parentmod', version: '1.0.0', depends: { needed: '>=1.0.0' } }, needed: { id: 'needed', version: '1.2.0' }, conflict: { id: 'parentmod', version: '2.0.0' }, wrong: { id: 'anothermod', version: '1.2.0' } })) {
    const dir = path.join(fixtures, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, environment: '*', ...metadata }));
  }
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; Get-ChildItem -LiteralPath $env:MINEBOT_MOD_FIXTURES -Directory | ForEach-Object { [System.IO.Compression.ZipFile]::CreateFromDirectory($_.FullName, ($_.FullName + ".jar")) }'], { windowsHide: true, env: { ...process.env, MINEBOT_MOD_FIXTURES: fixtures } });
  const directory = path.join(root, 'server/mods'); fs.mkdirSync(directory, { recursive: true });
  const parent = fs.readFileSync(path.join(fixtures, 'parent.jar')), needed = fs.readFileSync(path.join(fixtures, 'needed.jar'));
  fs.writeFileSync(path.join(directory, 'parent.jar'), parent);
  const game = { modLoader: 'fabric', minecraftVersion: '1.21.11', loaderVersion: '0.20.1', javaMajor: 21 };
  let report = await inspectMods(directory, game); assert.equal(report.missing[0].id, 'needed');
  global.fetch = async url => {
    url = String(url);
    if (url.endsWith('/version_files')) return Response.json({ [hash(parent)]: { files: [{ hashes: { sha512: hash(parent) } }], dependencies: [{ dependency_type: 'required', project_id: 'dep123' }] } });
    if (url.includes('/project/dep123/version')) return Response.json([{ project_id: 'dep123', version_type: 'release', loaders: ['fabric'], game_versions: ['1.21.11'], files: [{ primary: true, filename: 'needed.jar', hashes: { sha512: hash(needed) }, size: needed.length, url: 'https://cdn.modrinth.com/data/dep123/versions/v/needed.jar' }] }]);
    if (url.includes('cdn.modrinth.com')) return new Response(needed);
    throw Error(`Unexpected ${url}`);
  };
  fs.mkdirSync(path.join(root, 'cache'));
  fs.writeFileSync(path.join(root, 'cache', `${hash(needed)}.jar`), 'broken cached download');
  const prepared = await prepareModDependencies(directory, game, path.join(root, 'cache'));
  assert.equal(prepared.installed[0].id, 'needed'); report = await inspectMods(directory, game); assert.equal(report.missing.length, 0);
  assert.equal(fs.readdirSync(path.join(root, 'cache')).some(name => name.includes('.corrupt-')), true, '损坏缓存需保留后重下');
  fs.copyFileSync(path.join(directory, 'parent.jar'), path.join(directory, 'same-parent.jar'));
  const duplicate = await prepareModDependencies(directory, game, path.join(root, 'cache'));
  assert.equal(duplicate.quarantined.length, 1); assert.equal(fs.readFileSync(path.join(directory, 'parent.jar')).equals(parent), true);
  fs.copyFileSync(path.join(fixtures, 'conflict.jar'), path.join(directory, 'new-parent.jar'));
  await assert.rejects(prepareModDependencies(directory, game, path.join(root, 'cache')), /两个不同文件/);
  assert.ok(fs.existsSync(path.join(directory, 'new-parent.jar')), '版本冲突不能自动删除用户选择');
  let statusServer;
  try {
    const body = Buffer.from(JSON.stringify({ version: { name: '1.21.11', protocol: 774 }, players: { online: 0, max: 20 } }));
    const packet = Buffer.concat([varInt(0), varInt(body.length), body]);
    statusServer = net.createServer(socket => socket.once('data', () => { const data = Buffer.concat([varInt(packet.length), packet]); socket.write(data.subarray(0, 3)); setImmediate(() => socket.end(data.subarray(3))); }));
    await new Promise(resolve => statusServer.listen(0, '127.0.0.1', resolve));
    assert.equal((await probeServer(statusServer.address().port)).version, '1.21.11');
  } finally { if (statusServer) await new Promise(resolve => statusServer.close(resolve)); }
  console.log('verified mod dependencies, duplicate safety and Minecraft status probe tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
