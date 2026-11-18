const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ensureRuntime, launchArgs, safeVersion } = require('../src/services/server-runtime.cjs');
const { downloadFile } = require('../src/services/downloads.cjs');
const { prepareMrpack, checkedRelative } = require('../src/services/mrpack.cjs');
const { prepareVoiceMods, PROJECTS } = require('../src/services/managed-mods.cjs');
const { ServerManager } = require('../src/services/server-manager.cjs');
const { expectedJavaMajor, parseVersionMetadata } = require('../src/services/detector.cjs');
const { decodeRegistry, verifyVanillaIds, attachFabricRegistry } = require('../runtime/mindcraft-final/src/utils/fabric-registry.cjs');
const { enableProtocol20 } = require('../runtime/mindcraft-final/src/agent/voice-protocol.cjs');
const attachLegacyForgeHandshake = require('../runtime/mindcraft-final/src/utils/forge/client/forgeHandshake.cjs');

const hash = (data, type = 'sha512') => crypto.createHash(type).update(data).digest('hex');
function vi(n) { const bytes = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; bytes.push(b); } while (n); return Buffer.from(bytes); }
function str(value) { const data = Buffer.from(value); return Buffer.concat([vi(data.length), data]); }
function registryPacket(vanillaId = 0) {
  return Buffer.concat([vi(1), str(''), vi(1), str('item'), Buffer.from([0]), vi(2), str(''), vi(1), vi(vanillaId), vi(1), str('stone'), str('samplemod'), vi(1), vi(1), vi(1), str('tool')]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-cross-version-'));
  const originalFetch = global.fetch;
  try {
    assert.equal(expectedJavaMajor('26.1'), 25);
    const versionPath = path.join(root, '26.1-Fabric'); fs.mkdirSync(versionPath);
    fs.writeFileSync(path.join(versionPath, '26.1-Fabric.json'), JSON.stringify({ id: '26.1-Fabric', libraries: [{ name: 'net.fabricmc:fabric-loader:0.20.1' }], javaVersion: { majorVersion: 25 } }));
    assert.equal(parseVersionMetadata(versionPath, '26.1-Fabric').minecraftVersion, '26.1');
    assert.throws(() => safeVersion('../bad', '版本'), /有效/);
    assert.throws(() => checkedRelative('../escape'), /无效/);
    assert.throws(() => checkedRelative('mods/x:bad'), /无效/);
    const body = Buffer.alloc(2048, 42), launcher = Buffer.alloc(2048, 43);
    const files = { '/data/pack/shared.jar': Buffer.from('shared'), '/data/pack/server.jar': Buffer.from('server'), '/data/pack/client.jar': Buffer.from('client') };
    const voice = Buffer.from('voice fixture'), api = Buffer.from('fabric api fixture');
    let calls = 0, failVoice = false;
    global.fetch = async value => {
      calls++; const url = new URL(String(value));
      if (url.hostname === 'piston-meta.mojang.com' && url.pathname.endsWith('version_manifest_v2.json')) return Response.json({ versions: [{ id: '1.21.11', url: 'https://piston-meta.mojang.com/v1/test.json' }] });
      if (url.hostname === 'piston-meta.mojang.com') return Response.json({ id: '1.21.11', downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', sha1: hash(body, 'sha1') } } });
      if (url.hostname === 'piston-data.mojang.com') return new Response(body);
      if (url.hostname === 'meta.fabricmc.net' && url.pathname.endsWith('/server/json')) return Response.json({ mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotServer', libraries: ['loader','intermediary'].map(name => ({ name: `net.fabricmc:${name}:1.0`, url: 'https://maven.fabricmc.net/', sha512: hash(body) })) });
      if (url.hostname === 'maven.fabricmc.net') return new Response(body);
      if (url.hostname === 'meta.fabricmc.net' && url.pathname.endsWith('/installer')) return Response.json([{ stable: true, version: '1.1.2' }]);
      if (url.hostname === 'meta.fabricmc.net' && url.pathname.endsWith('/server/jar')) return new Response(launcher);
      if (url.hostname === 'api.modrinth.com') {
        const id = url.pathname.split('/')[3], bytes = id === PROJECTS.voice ? voice : api;
        if (id === PROJECTS.voice && failVoice) return Response.json([]);
        return Response.json([{ project_id: id, loaders: ['fabric'], game_versions: ['1.21.11'], version_type: 'release', dependencies: [], version_number: 'test', files: [{ filename: id === PROJECTS.voice ? 'voicechat-fabric-test.jar' : 'fabric-api-test.jar', primary: true, url: `https://cdn.modrinth.com/data/${id}/versions/test/file.jar`, hashes: { sha512: hash(bytes) }, size: bytes.length }] }]);
      }
      if (url.hostname === 'cdn.modrinth.com') {
        if (url.pathname.includes(PROJECTS.voice)) return new Response(voice);
        if (url.pathname.includes(PROJECTS.fabricApi)) return new Response(api);
        if (files[url.pathname]) return new Response(files[url.pathname]);
      }
      if (url.hostname === 'meta.fabricmc.net' && url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
      throw new Error(`Unexpected URL ${url}`);
    };
    await assert.rejects(downloadFile('https://meta.fabricmc.net/redirect', path.join(root, 'redirect'), { hosts: ['meta.fabricmc.net'] }), /未允许/);
    const game = { minecraftVersion: '1.21.11', modLoader: 'fabric', loaderVersion: '0.20.1' };
    const runtime = await ensureRuntime(path.join(root, 'runtimes'), game, 'java');
    assert.ok(launchArgs(runtime, game).includes('-Dfabric.gameJarPath=server.jar'));
    assert.ok(launchArgs(runtime, game).includes('net.fabricmc.loader.impl.launch.knot.KnotServer'));
    const count = calls; assert.equal(await ensureRuntime(path.join(root, 'runtimes'), game, 'java'), runtime); assert.equal(calls, count);
    fs.writeFileSync(path.join(runtime, 'server.jar'), 'tampered');
    assert.equal(await ensureRuntime(path.join(root, 'runtimes'), game, 'java'), runtime);
    assert.deepEqual(fs.readFileSync(path.join(runtime, 'server.jar')), body);
    assert.ok(fs.readdirSync(path.join(root, 'runtimes')).some(name => name.includes('.preserved-')), '损坏缓存应保留，并自动重建');

    const pack = path.join(root, 'pack'); fs.mkdirSync(pack);
    const entry = (name, url, side) => ({ path: `mods/${name}.jar`, fileSize: files[url].length, hashes: { sha512: hash(files[url]) }, downloads: [`https://cdn.modrinth.com${url}`], env: side });
    fs.writeFileSync(path.join(pack, 'modrinth.index.json'), JSON.stringify({ formatVersion: 1, game: 'minecraft', files: [entry('shared', '/data/pack/shared.jar', {}), entry('server', '/data/pack/server.jar', { client: 'unsupported' }), entry('client', '/data/pack/client.jar', { server: 'unsupported' })] }));
    const imported = await prepareMrpack(pack);
    assert.equal(imported.downloaded, 3);
    assert.deepEqual(imported.serverExcluded, ['mods/client.jar']);
    assert.equal(fs.readFileSync(path.join(pack, 'overrides/mods/shared.jar'), 'utf8'), 'shared');
    assert.equal(fs.readFileSync(path.join(pack, 'server-overrides/mods/server.jar'), 'utf8'), 'server');

    const instance = path.join(root, 'voice-instance'), server = path.join(root, 'voice-server');
    const installed = await prepareVoiceMods({ game, instanceRoot: instance, serverDirectory: server, cacheRoot: path.join(root, 'cache') });
    assert.equal(installed.length, 4);
    assert.equal(fs.readFileSync(path.join(instance, 'mods/voicechat-fabric-test.jar'), 'utf8'), 'voice fixture');
    assert.equal(fs.readFileSync(path.join(server, 'mods/fabric-api-test.jar'), 'utf8'), 'fabric api fixture');
    assert.deepEqual(await prepareVoiceMods({ game, instanceRoot: instance, serverDirectory: server, cacheRoot: path.join(root, 'cache') }), []);
    const cachedMods = fs.readdirSync(path.join(root, 'cache')).filter(name => name.endsWith('.jar'));
    for (const file of cachedMods) fs.writeFileSync(path.join(root, 'cache', file), 'corrupt');
    const repairedMods = await prepareVoiceMods({ game, instanceRoot: path.join(root, 'repaired-client'), serverDirectory: path.join(root, 'repaired-server'), cacheRoot: path.join(root, 'cache') });
    assert.equal(repairedMods.length, 4, '语音依赖缓存损坏后应自动恢复');
    assert.equal(fs.readdirSync(path.join(root, 'cache')).filter(name => name.includes('.corrupt-')).length, cachedMods.length);
    const failedInstance = path.join(root, 'failed-instance'), failedServer = path.join(root, 'failed-server');
    fs.mkdirSync(path.join(failedInstance, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(failedInstance, 'mods', 'user-owned.jar'), 'keep');
    failVoice = true;
    await assert.rejects(prepareVoiceMods({ game, instanceRoot: failedInstance, serverDirectory: failedServer, cacheRoot: path.join(root, 'cache') }), /没有找到/);
    assert.equal(fs.readFileSync(path.join(failedInstance, 'mods', 'user-owned.jar'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(failedInstance, 'mods', 'fabric-api-test.jar')), false, '安装失败时回滚本次新添文件');
    failVoice = false;

    const template = path.join(root, 'template');
    fs.mkdirSync(path.join(template, 'libraries/net/minecraftforge/forge/1.20.1-47.4.23'), { recursive: true });
    fs.writeFileSync(path.join(template, 'libraries/net/minecraftforge/forge/1.20.1-47.4.23/win_args.txt'), 'test');
    const fresh = path.join(root, 'empty-instance'); fs.mkdirSync(fresh);
    const manager = new ServerManager(path.join(root, 'profile'), { inspectInstance: () => ({ contentRoot: fresh, worlds: [] }) });
    const build = await manager.prepareWorkspace({ game: { instancePath: fresh, worldPath: '', minecraftVersion: '1.20.1', modLoader: 'forge', loaderVersion: '47.4.23' }, server: { templatePath: template }, network: { gameLocalPort: 25570 } });
    assert.equal(fs.existsSync(path.join(build.directory, 'world')), false, '新世界由服务端生成');
    assert.match(fs.readFileSync(path.join(build.directory, 'server.properties'), 'utf8'), /^online-mode=false$/m);

    const data = { items: { 0: { id: 0, name: 'stone' } }, itemsByName: { stone: { id: 0 } }, effects: {}, attributes: {} };
    const decoded = decodeRegistry(registryPacket());
    assert.equal(verifyVanillaIds(decoded, data), 1);
    assert.throws(() => verifyVanillaIds(decodeRegistry(registryPacket(1)), data), /编号不一致/);
    assert.throws(() => verifyVanillaIds([{ name: 'minecraft:block', entries: [] }], data), /尚不支持/);
    assert.throws(() => decodeRegistry(Buffer.from([255])), /不完整/);
    const forgeClient = new EventEmitter(); const forgeWrites = [];
    forgeClient.write = (kind, packet) => forgeWrites.push({ kind, ...packet });
    attachLegacyForgeHandshake(forgeClient, {});
    forgeClient.emit('custom_payload', { channel: 'FML|HS', data: Buffer.from([0, 2, 0, 0, 0, 0]) });
    assert.equal(forgeClient.fmlHandshakeState, 2, '旧版 Forge 首次 ServerHello 应进入等待服务端数据状态');
    assert.ok(forgeWrites.some(packet => packet.channel === 'REGISTER'));
    const client = new EventEmitter(); const writes = []; client.write = (kind, value) => writes.push({ kind, ...value }); client.end = reason => { client.ended = reason; };
    attachFabricRegistry({ _client: client }, '1.21.11', data);
    client.state = 'configuration'; client.emit('state', 'configuration'); client.emit('custom_payload', { channel: 'fabric:registry/sync', data: registryPacket() });
    assert.ok(writes.some(item => item.channel === 'fabric:registry/sync/complete'));
    client.emit('custom_payload', { channel: 'fabric:registry/sync', data: Buffer.from([255]) });
    assert.match(client.ended, /不兼容/);
    const encryption = {}, stored = { secretPacketData: { secret: { mostSignificantBits: 1n, leastSignificantBits: 2n } } };
    enableProtocol20(encryption, stored);
    const plaintext = Buffer.from('voice-transport');
    const ciphertext = encryption.encrypt(plaintext);
    assert.deepEqual(encryption.decrypt(ciphertext), plaintext);
    ciphertext[ciphertext.length - 1] ^= 1;
    assert.throws(() => encryption.decrypt(ciphertext), /authenticat/i);
    console.log('cross-version runtime, modpack, voice and Fabric safety tests passed');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
