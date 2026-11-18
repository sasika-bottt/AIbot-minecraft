const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const nbt = require('prismarine-nbt');
const { EventEmitter } = require('node:events');
const { worldManifest, snapshotWorld, selectWorld, validateWorld, recordSession, writeJson } = require('../src/services/world-recovery.cjs');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { downloadFile, fetchJson } = require('../src/services/downloads.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-recovery-pipeline-'));
const originalFetch = global.fetch;
function level(version = 4671) { return zlib.gzipSync(nbt.writeUncompressed({ type: 'compound', name: '', value: { Data: { type: 'compound', value: { DataVersion: { type: 'int', value: version }, LevelName: { type: 'string', value: '测试世界' } } } } })); }
async function main() {
  const instance = path.join(root, 'instance'), source = path.join(instance, 'saves', 'world'), builds = path.join(root, 'builds'), build = path.join(builds, '2026-11-14-test'), world = path.join(build, 'world'), backups = path.join(root, 'backups');
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'level.dat'), level()); fs.mkdirSync(build, { recursive: true }); fs.cpSync(source, world, { recursive: true });
  await writeJson(path.join(build, 'build-info.json'), { sourceInstance: instance, sourceWorld: source });
  await recordSession(build, { phase: 'failed', everReady: false, pid: null });
  await writeJson(path.join(build, '.minebot-world-baseline.json'), await worldManifest(world));
  const options = { buildsRoot: builds, instanceRoot: instance, sourceWorld: source, worldPath: source, backupsRoot: backups };
  const pristine = await selectWorld(options);
  assert.equal(pristine.world, world); assert.equal(pristine.recovered, false); assert.equal(fs.existsSync(path.join(build, '.minebot-clean-stop')), false);
  fs.writeFileSync(path.join(world, 'level.dat'), level(4672));
  await recordSession(build, { phase: 'failed', everReady: true, pid: null });
  const before = await worldManifest(world), recovered = await selectWorld(options);
  assert.equal(recovered.recovered, true); assert.equal(recovered.report.dataVersion, 4672);
  assert.deepEqual(await worldManifest(world), before, '恢复不得修改原世界');
  assert.deepEqual(await worldManifest(recovered.world), before, '恢复副本必须校验一致');
  assert.equal(fs.existsSync(path.join(build, '.minebot-clean-stop')), false, '恢复不能伪造正常停服标记');
  await recordSession(build, { phase: 'ready', everReady: true, pid: process.pid });
  await assert.rejects(selectWorld(options), /进程.*仍可能运行/);
  await recordSession(build, { phase: 'failed', pid: null });
  fs.mkdirSync(path.join(world, 'region'));
  fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), Buffer.alloc(10));
  await assert.rejects(selectWorld(options), /未确认安全停服.*区域文件头不完整/s);
  assert.deepEqual(fs.readFileSync(path.join(source, 'level.dat')), level(), '用户原存档保持完整');
  const corrupt = path.join(root, 'corrupt'); fs.mkdirSync(corrupt); fs.writeFileSync(path.join(corrupt, 'level.dat'), 'bad');
  await assert.rejects(validateWorld(corrupt), /主文件无法验证/);

  let calls = 0;
  global.fetch = async () => { if (++calls < 3) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; } return new Response('verified'); };
  const downloaded = path.join(root, 'resource');
  await downloadFile('https://meta.fabricmc.net/file', downloaded, { hosts: ['meta.fabricmc.net'], retries: 2, retryDelayMs: 0 });
  assert.equal(calls, 3); assert.equal(fs.readFileSync(downloaded, 'utf8'), 'verified');
  calls = 0; global.fetch = async () => { calls++; return new Response('bad', { status: 404 }); };
  await assert.rejects(downloadFile('https://meta.fabricmc.net/missing', path.join(root, 'missing'), { hosts: ['meta.fabricmc.net'], retryDelayMs: 0 }), /HTTP 404/);
  assert.equal(calls, 1, '不存在的资源不应无限重试');
  calls = 0; global.fetch = async () => { calls++; return Response.json({ error: true }, { status: 503 }); };
  await assert.rejects(fetchJson('https://meta.fabricmc.net/missing', 'meta.fabricmc.net', { retryDelayMs: 0 }), /HTTP 503/);
  assert.equal(calls, 3);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.part')), false);

  const template = path.join(root, 'template'); fs.mkdirSync(template); fs.writeFileSync(path.join(template, 'server.jar'), 'test launcher');
  async function lifecycle(saved, fail = false) {
    let child;
    const manager = new ServerManager(path.join(root, fail ? 'failed-exit' : saved ? 'normal' : 'uncertain'), { probeServer: async () => ({ version: '1.21.11', protocol: 774, online: 0 }), spawn: () => {
      child = new EventEmitter(); child.pid = 99999999; child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { writable: true, write: command => { if (command === 'stop\n') setImmediate(() => { child.stdout.emit('data', saved ? 'Stopping server\nAll dimensions are saved\n' : 'Shutdown incomplete\n'); child.exitCode = fail ? 1 : 0; child.emit('close', child.exitCode); }); } };
      setImmediate(() => child.stdout.emit('data', 'Done (0.1s)! For help, type help\n')); return child;
    } });
    manager.prepareEnvironment = async () => ({ javaPath: 'java', template });
    let failureStarted, releaseFailure;
    const failureSeen = new Promise(resolve => { failureStarted = resolve; });
    const failureGate = new Promise(resolve => { releaseFailure = resolve; });
    const journal = manager.journal.bind(manager);
    manager.journal = async (dir, update) => { if (fail && update.phase === 'failed') { failureStarted(); await failureGate; } return journal(dir, update); };
    await manager.buildAndStart({ game: { instancePath: instance, worldPath: source, minecraftVersion: '1.21.11', modLoader: 'vanilla' }, server: { templatePath: template }, network: { gameLocalPort: 25599 } });
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(manager.status().ready, true);
    const directory = manager.status().serverDirectory; const stopping = manager.stopAndWait(5000);
    if (fail) {
      await failureSeen;
      assert.equal(manager.status().busy, true, '退出记录未完成时必须保持忙碌');
      await assert.rejects(manager.buildAndStart({}), /正在构建或同步/);
      releaseFailure();
    }
    await stopping;
    assert.equal(fs.existsSync(path.join(directory, '.minebot-clean-stop')), saved);
    if (!saved && !fail) assert.equal(manager.status().syncFailed, true);
    return { manager, directory };
  }
  const { manager, directory } = await lifecycle(true); await lifecycle(false); await lifecycle(false, true);
  const target = manager.status().mirrorPath;
  const prior = path.join(path.dirname(target), `.${path.basename(target)}.previous-test`);
  fs.renameSync(target, prior);
  await writeJson(path.join(directory, '.minebot-sync.json'), { phase: 'swapping', target, previous: prior });
  const anotherInstance = path.join(root, 'another-game'); fs.mkdirSync(anotherInstance);
  await manager.retrySync({ game: { instancePath: anotherInstance } });
  assert.ok(fs.existsSync(path.join(target, 'level.dat')), '中断的导出应能恢复并重新同步');
  assert.equal(fs.existsSync(path.join(anotherInstance, 'saves')), false, '切换整合包后重试同步不得写错游戏目录');
  await writeJson(path.join(directory, 'build-info.json'), { sourceInstance: path.join(root, 'missing-game') });
  await assert.rejects(manager.retrySync({ game: { instancePath: anotherInstance } }), /原游戏目录不存在/);
  assert.equal(fs.existsSync(path.join(anotherInstance, 'saves')), false);
  console.log('recovery, network retry, shutdown evidence and interrupted export tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
