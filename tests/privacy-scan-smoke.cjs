const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { formatFinding, scanFiles, scanRepository } = require('../scripts/privacy-scan.cjs');

function write(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-privacy-'));

try {
  write(root, 'README.md', [
    '下载地址：https://github.com/sasika-bottt/AIbot-minecraft',
    '示例域名：server.example.invalid:25565',
    String.raw`示例路径：C:\Users\<用户名>\AppData\Roaming\minebot-desktop`
  ].join('\n'));
  write(root, 'docs/guide.md', '只包含通用产品说明。');
  write(root, 'src/example.js', [
    'const publicAddress=state.config.network.gameAddress;',
    'const gameAddress=config.gameAddress;',
    'const nickname=config.nickname;'
  ].join('\n'));

  const clean = scanFiles(root, ['README.md', 'docs/guide.md', 'src/example.js']);
  assert.deepEqual(clean, [], '明显虚构的示例和官方项目链接不应被误报');

  const userPath = ['E:', 'Games', 'PrivatePack', 'saves'].join('\\');
  const tunnelHost = ['voice_host=', 'personal-tunnel', '.', 'example.net', ':32594'].join('');
  const bypassHost = ['gameAddress=', 'safe.example.com.evil', ':25565'].join('');
  const multipleHosts = [
    ['voice', 'Address=voice.invalid:24454'].join(''),
    ['game', 'Address=private.example.net:25565'].join('')
  ].join(' ');
  const personalNames = ['nickname=', 'PrivatePlayer', '\nworldName=', 'PrivateWorld'].join('');
  write(root, 'notes/session.md', `运行目录：${userPath}\n${tunnelHost}\n${bypassHost}\n${multipleHosts}\n${personalNames}`);
  write(root, 'assets/companion-avatar.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(root, 'world/playerdata/sample.dat', 'binary-placeholder');
  write(root, 'notes/large.txt', `${'x'.repeat(2 * 1024 * 1024 + 16)}\n${tunnelHost}`);

  const findings = scanFiles(root, [
    'notes/session.md',
    'assets/companion-avatar.png',
    'world/playerdata/sample.dat',
    'notes/large.txt'
  ]);
  const rules = new Set(findings.map((finding) => finding.rule));

  assert.ok(rules.has('absolute-user-path'), '应拦截真实 Windows 用户绝对路径');
  assert.ok(rules.has('filled-network-endpoint'), '应拦截已填写的公网语音或隧道地址');
  assert.ok(rules.has('personal-skin-asset'), '应拦截个人伙伴皮肤资产');
  assert.ok(rules.has('world-data'), '应拦截世界和玩家数据');
  assert.ok(rules.has('filled-personal-name'), '应拦截已填写的昵称和世界名称');
  assert.ok(findings.some((finding) => finding.file === 'notes/large.txt'), '大于 2 MiB 的文本也必须扫描');
  assert.ok(findings.every((finding) => !('match' in finding)), '扫描结果不得回显敏感原文');
  const privateFile = ['saves', 'PrivateWorld', 'playerdata', 'sample.dat'].join('/');
  const formatted = formatFinding({ file: privateFile, rule: 'world-data', line: 1 }, 0);
  assert.ok(!formatted.includes('PrivateWorld'), '默认日志不得回显可能包含世界名的文件路径');

  const historyRoot = path.join(root, 'history-repo');
  fs.mkdirSync(historyRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: historyRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'privacy-test'], { cwd: historyRoot });
  execFileSync('git', ['config', 'user.email', 'privacy-test@example.invalid'], { cwd: historyRoot });
  const oldPath = ['D:', 'PrivateGames', 'Pack', 'saves'].join('\\');
  write(historyRoot, 'notes/private.md', `source=${oldPath}`);
  execFileSync('git', ['add', '.'], { cwd: historyRoot });
  execFileSync('git', ['commit', '-m', 'add private fixture'], { cwd: historyRoot, stdio: 'ignore' });
  fs.rmSync(path.join(historyRoot, 'notes/private.md'));
  write(historyRoot, 'README.md', 'clean head');
  execFileSync('git', ['add', '-A'], { cwd: historyRoot });
  execFileSync('git', ['commit', '-m', 'remove private fixture'], { cwd: historyRoot, stdio: 'ignore' });

  const historyFindings = scanRepository(historyRoot);
  assert.ok(historyFindings.some((finding) => finding.rule === 'absolute-user-path'), 'HEAD 已删除的旧历史个人路径也必须被拦截');

  console.log('privacy-scan-smoke: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
