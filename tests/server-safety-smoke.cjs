const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ServerManager, findWinArgs, resolveTemplate, updateProperties } = require('../src/services/server-manager.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-safety-'));
  try {
    const manager = new ServerManager(root, {});
    const world = path.join(root, 'world');
    fs.mkdirSync(world);
    fs.writeFileSync(path.join(world, 'level.dat'), 'test-world');
    fs.writeFileSync(path.join(world, 'session.lock'), 'temporary lock');
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const commands = [];
    child.stdin = { writable: true, write(command) {
      commands.push(command.trim());
      if (command === 'save-all flush\n' && commands.length === 2) setImmediate(() => child.stdout.emit('data', 'Saved the game'));
    } };
    manager.child = child;
    manager.state = { ...manager.state, ready: true, serverDirectory: root };
    const result = await manager.executeAdminCommands(['/setblock 1 64 1 stone']);
    assert.match(result.message, /已提交/);
    assert.ok(fs.existsSync(path.join(result.backupPath, 'level.dat')));
    assert.equal(fs.existsSync(path.join(result.backupPath, 'session.lock')), false);
    assert.deepEqual(commands, ['save-off', 'save-all flush', 'save-on', 'setblock 1 64 1 stone', 'save-all flush']);

    const failed = new EventEmitter();
    failed.exitCode = null; failed.stdout = new EventEmitter(); failed.stderr = new EventEmitter();
    const failedCommands = [];
    failed.stdin = { writable: true, write(command) { failedCommands.push(command.trim()); if (command === 'save-all flush\n') setImmediate(() => failed.emit('exit', 1)); } };
    manager.child = failed;
    await assert.rejects(manager.executeAdminCommands(['/setblock 1 64 1 stone']), /已退出/);
    assert.ok(!failedCommands.some((value) => value.startsWith('setblock')));
    assert.ok(failedCommands.includes('save-on'));

    const folder = path.join(root, 'libraries', 'net', 'minecraftforge', 'forge');
    for (const version of ['1.19.2-43.3.0', '1.20.1-47.4.23']) {
      fs.mkdirSync(path.join(folder, version), { recursive: true });
      fs.writeFileSync(path.join(folder, version, 'win_args.txt'), 'args');
    }
    assert.match(findWinArgs(root, { minecraftVersion: '1.20.1', loaderVersion: '47.4.23' }), /1\.20\.1-47\.4\.23/);
    assert.equal(findWinArgs(root, { minecraftVersion: '1.20.1', loaderVersion: '47.0.1' }), '');
    assert.equal(resolveTemplate(path.join(root, 'missing'), [root], { minecraftVersion: '1.20.1' }), '', '显式选择错误时不得回退到其他服务端');
    assert.equal((updateProperties(' online-mode = true\nonline-mode:false\n', { 'online-mode': 'false' }).match(/online-mode=false/g) || []).length, 1);
    const guarded = new ServerManager(root, {});
    let releaseStart;
    guarded.startOnce = () => new Promise(resolve => { releaseStart = resolve; });
    const starting = guarded.buildAndStart({});
    assert.equal(guarded.status().busy, true);
    await assert.rejects(guarded.buildAndStart({}), /正在构建/);
    releaseStart({}); await starting;
    guarded.state.phase = 'syncing';
    await assert.rejects(guarded.buildAndStart({}), /同步存档/);
    let stopped = false;
    const stopping = guarded.stopAndWait(1000).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, false, '退出必须等待存档同步结束');
    guarded.state.phase = 'stopped'; guarded.resolveStopWaiters(); await stopping;
    console.log('server safety smoke test passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
