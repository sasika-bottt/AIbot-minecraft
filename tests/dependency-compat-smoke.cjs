const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const runtime = path.resolve(process.env.MINEBOT_TEST_RUNTIME || path.join(__dirname, '../runtime/mindcraft-final'));
  const requireRuntime = createRequire(path.join(runtime, 'package.json'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-dependency-'));
  const previous = process.cwd();
  try {
    const uuid = requireRuntime('uuid');
    assert.equal(requireRuntime('uuid/package.json').version, '11.1.1');
    assert.ok(uuid.validate(uuid.v4()));
    assert.equal(uuid.v5('minebot', uuid.v5.DNS), uuid.v5('minebot', uuid.v5.DNS));
    for (const generate of [uuid.v3, uuid.v5]) assert.throws(() => generate('test', uuid.v5.DNS, new Uint8Array(8), 4), RangeError);
    assert.throws(() => uuid.v6({}, new Uint8Array(8), 4), RangeError);
    const yggdrasil = requireRuntime('yggdrasil');
    assert.ok(yggdrasil()); // Constructs a v4 client token without network login.
    assert.ok(requireRuntime('@azure/msal-node').PublicClientApplication);

    const mm = requireRuntime('minimatch');
    assert.equal(requireRuntime('minimatch/package.json').version, '11.0.1');
    assert.ok(new mm.Minimatch('**/*.js').match('src/a.js'));
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested/a.js'), 'test');
    fs.writeFileSync(path.join(root, 'nested/b.txt'), 'test');
    const nativeRequire = createRequire(requireRuntime.resolve('@discordjs/node-pre-gyp'));
    const cleanup = nativeRequire('rimraf');
    assert.equal(nativeRequire('rimraf/package.json').name, '@minebot/rimraf-literal-compat');
    assert.deepEqual(fs.readFileSync(nativeRequire.resolve('rimraf')), fs.readFileSync(path.join(__dirname, '../runtime/mindcraft-final/vendor/rimraf-literal/index.cjs')), '安装的清理适配层必须对应仓库源文件');
    await assert.rejects(new Promise((resolve, reject) => cleanup(path.join(root, 'nested/*.txt'), error => error ? reject(error) : resolve())), /literal path/);
    await new Promise((resolve, reject) => cleanup(path.join(root, 'nested/b.txt'), error => error ? reject(error) : resolve()));
    assert.equal(fs.existsSync(path.join(root, 'nested/b.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'nested/a.js')), true);
    cleanup.sync(path.join(root, 'nested'));
    cleanup.sync(path.join(root, 'missing'));
    assert.throws(() => cleanup.sync(path.parse(root).root), /Refusing/);
    const brackets = path.join(root, 'build [x]');
    fs.mkdirSync(brackets); fs.writeFileSync(path.join(brackets, 'test'), 'test');
    cleanup.sync(brackets);
    assert.equal(fs.existsSync(brackets), false);

    const { OpusEncoder } = requireRuntime('@discordjs/opus');
    const codec = new OpusEncoder(48000, 1);
    const packet = codec.encode(Buffer.alloc(960 * 2));
    assert.ok(packet.length > 0);
    assert.equal(codec.decode(packet).length, 960 * 2);

    process.chdir(root);
    fs.writeFileSync(path.join(root, 'eslint.config.cjs'), 'throw new Error("External config must not be executed");');
    const { lintGeneratedCode } = await import(pathToFileURL(path.join(runtime, 'src/agent/code-lint.js')));
    const valid = await lintGeneratedCode('export async function main(bot) { await Promise.resolve(bot); }');
    assert.equal(valid[0].errorCount, 0);
    const invalid = await lintGeneratedCode('export function main() { missingFunction(); }');
    assert.ok(invalid[0].messages.some(message => message.ruleId === 'no-undef'));
    assert.ok((await lintGeneratedCode('export function main( {'))[0].fatalErrorCount > 0);
    const { ESLint } = requireRuntime('eslint');
    const fileLinter = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.js'], ignores: ['**/skip.js'], rules: { 'no-undef': 'error' } }] });
    const lintRoot = path.join(root, 'lint'); fs.mkdirSync(lintRoot);
    fs.writeFileSync(path.join(lintRoot, 'good.js'), 'const value = 1;');
    fs.writeFileSync(path.join(lintRoot, 'bad.js'), 'missingName();');
    const linted = await fileLinter.lintFiles(['lint/**/*.js']);
    assert.equal(linted.length, 2);
    assert.equal(linted.find(item => item.filePath.endsWith('bad.js')).errorCount, 1);
    const { Coder } = await import(pathToFileURL(path.join(runtime, 'src/agent/coder.js')));
    const coder = Object.create(Coder.prototype);
    coder.agent = { prompter: { skill_libary: { getAllSkillDocs: async () => [] } } };
    assert.equal(await coder._lintCode('export async function main(bot) { await Promise.resolve(bot); }'), null);
    assert.match(await coder._lintCode('export function main() { missingName(); }'), /not defined/);
    console.log('patched dependencies, native cleanup adapter, Opus codec and isolated code lint passed');
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
