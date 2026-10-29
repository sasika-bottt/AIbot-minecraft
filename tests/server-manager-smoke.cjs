const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { ServerManager, assessRuntimeCompatibility, selectJavaRuntime, diagnoseServerOutput, validateAdminCommands, renameWorldDisplayName, offlinePlayerUuid } = require('../src/services/server-manager.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockmate-server-'));
  try {
    const template = path.join(root, 'template');
    const instance = path.join(root, 'instance');
    const world = path.join(instance, 'saves', '测试世界');
    fs.mkdirSync(path.join(template, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.23'), { recursive: true });
    fs.mkdirSync(path.join(template, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(instance, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(instance, 'config'), { recursive: true });
    fs.mkdirSync(world, { recursive: true });
    fs.writeFileSync(path.join(template, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.23', 'win_args.txt'), 'forge args');
    fs.writeFileSync(path.join(template, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(template, 'user_jvm_args.txt'), '-Xmx4G\n');
    fs.writeFileSync(path.join(template, 'server.properties'), 'server-port=25565\nenable-rcon=true\nonline-mode=false\nlevel-name=old\n');
    fs.writeFileSync(path.join(template, 'ops.json'), JSON.stringify([{ uuid: offlinePlayerUuid('OldAdmin'), name: 'OldAdmin', level: 4 }]));
    fs.writeFileSync(path.join(world, 'level.dat'), 'world-data');
    fs.writeFileSync(path.join(instance, 'mods', 'user-owned-mod.jar'), 'mod-data');
    fs.writeFileSync(path.join(instance, 'mods', 'oculus-mc1.20.1-1.8.0.jar'), 'client-only-data');
    fs.writeFileSync(path.join(instance, 'config', 'modernfix-mixins.properties'), '# generated\n');
    const manager = new ServerManager(path.join(root, 'profile'), { systemScan: async () => ({}) });
    const result = await manager.prepareWorkspace({
      game: { instancePath: instance, worldPath: world },
      network: { gameLocalPort: 25570 },
      server: { templatePath: template, administrators: ['SamplePlayer', 'friend'], revokedAdministrators: ['OldAdmin'] }
    });
    assert.equal(fs.readFileSync(path.join(result.directory, 'world', 'level.dat'), 'utf8'), 'world-data');
    assert.equal(offlinePlayerUuid('SamplePlayer'), '6a4bb51a-8896-3a3f-91dd-73e42c277ddc');
    const operators = JSON.parse(fs.readFileSync(path.join(result.directory, 'ops.json'), 'utf8'));
    assert.deepEqual(operators.map((entry) => entry.name), ['SamplePlayer', 'friend']);
    assert.equal(operators[0].level, 4);
    assert.equal(fs.readFileSync(path.join(result.directory, 'mods', 'user-owned-mod.jar'), 'utf8'), 'mod-data');
    assert.equal(fs.existsSync(path.join(result.directory, 'mods', 'oculus-mc1.20.1-1.8.0.jar')), false);
    assert.deepEqual(result.excludedMods.map((entry) => entry.name), ['oculus-mc1.20.1-1.8.0.jar']);
    const buildInfo = JSON.parse(fs.readFileSync(path.join(result.directory, 'build-info.json'), 'utf8'));
    assert.deepEqual(buildInfo.excludedMods, result.excludedMods);
    assert.match(fs.readFileSync(path.join(result.directory, 'config', 'modernfix-mixins.properties'), 'utf8'), /^mixin\.perf\.smart_ingredient_sync=false$/m);
    const properties = fs.readFileSync(path.join(result.directory, 'server.properties'), 'utf8');
    assert.match(properties, /server-port=25570/);
    assert.match(properties, /enable-rcon=false/);
    assert.match(properties, /level-name=world/);
    const workBuddyWorld = path.join(template, 'world');
    fs.mkdirSync(workBuddyWorld, { recursive: true });
    fs.writeFileSync(path.join(workBuddyWorld, 'level.dat'), 'newer-workbuddy-world');
    const externalResult = await manager.prepareWorkspace({
      game: { instancePath: instance, worldPath: workBuddyWorld },
      network: { gameLocalPort: 25571 },
      server: { templatePath: template }
    });
    assert.equal(fs.readFileSync(path.join(externalResult.directory, 'world', 'level.dat'), 'utf8'), 'newer-workbuddy-world');
    const fixedDate = new Date(2026, 9, 27, 16, 30, 0);
    const firstMirror = await manager.exportDailyWorld(externalResult.directory, instance, fixedDate);
    assert.equal(path.basename(firstMirror.path), '境伴-2026-10-27');
    assert.equal(fs.readFileSync(path.join(firstMirror.path, 'level.dat'), 'utf8'), 'newer-workbuddy-world');
    fs.writeFileSync(path.join(externalResult.directory, 'world', 'level.dat'), 'updated-after-stop');
    const secondMirror = await manager.exportDailyWorld(externalResult.directory, instance, new Date(2026, 9, 27, 17, 0, 0));
    assert.equal(fs.readFileSync(path.join(secondMirror.path, 'level.dat'), 'utf8'), 'updated-after-stop');
    assert.equal(fs.existsSync(path.join(instance, 'saves', '.境伴备份')), false);
    const nbtPath = path.join(root, 'level-name-test.dat');
    const tag = Buffer.from([10, 0, 0, 8, 0, 9, ...Buffer.from('LevelName'), 0, 3, ...Buffer.from('old'), 0]);
    fs.writeFileSync(nbtPath, zlib.gzipSync(tag));
    assert.equal(await renameWorldDisplayName(nbtPath, '境伴-2026-10-27'), true);
    assert.match(zlib.gunzipSync(fs.readFileSync(nbtPath)).toString('utf8'), /境伴-2026-10-27/);
    assert.deepEqual(validateAdminCommands(['/setblock 1 64 1 stone', '/fill ~0 ~0 ~0 ~3 ~3 ~3 oak_planks']), ['/setblock 1 64 1 stone', '/fill ~0 ~0 ~0 ~3 ~3 ~3 oak_planks']);
    assert.throws(() => validateAdminCommands(['/op bbb']), /不允许/);
    assert.throws(() => validateAdminCommands(['/fill 0 0 0 100 100 100 stone']), /安全上限/);
    assert.equal(assessRuntimeCompatibility({ minecraftVersion: '1.19.2', modLoader: 'forge', loaderVersion: '43.3.0' }).ok, true);
    assert.equal(assessRuntimeCompatibility({ minecraftVersion: '1.20.1', modLoader: 'fabric' }).ok, false);
    assert.equal(selectJavaRuntime({ javaCandidates: [{ major: 8, path: 'java8' }, { major: 17, path: 'java17' }] }, { minecraftVersion: '1.20.1' }).selected.path, 'java17');
    assert.match(diagnoseServerOutput('java.lang.OutOfMemoryError: Java heap space'), /内存不足/);
    console.log('server manager preparation smoke test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
