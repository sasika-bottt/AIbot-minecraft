const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows 安装包需要在 Windows x64 上使用 Node.js 构建。');
}
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 22) {
  throw new Error(`伙伴原生依赖要求 Node.js 22，当前构建进程为 ${process.version}。请切换到 Node.js 22 后重新打包。`);
}
const agentDeps = path.join(root, 'runtime', 'mindcraft-final', 'node_modules', 'mineflayer');
if (!fs.existsSync(agentDeps)) {
  throw new Error('缺少伙伴运行依赖，请先执行 npm --prefix runtime/mindcraft-final ci --omit=dev。');
}
const core = path.join(root, 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js');
if (!fs.existsSync(core)) throw new Error('缺少 WorkBuddy 通道组件，请先执行 npm ci。');
// Never ship linked local projects, which can recursively include dist, logs,
// or user data when the archive tool follows directory junctions.
function assertNoLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`伙伴依赖包含目录链接，请重新安装依赖后打包：${target}`);
    if (entry.isDirectory()) assertNoLinks(target);
  }
}
assertNoLinks(path.join(root, 'runtime', 'mindcraft-final', 'node_modules'));
const nodeTarget = path.join(root, 'runtime', 'node.exe');
const digest = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Windows locks a running executable. Avoid overwriting an identical bundled
// runtime while an isolated test is using it.
if (!fs.existsSync(nodeTarget) || digest(process.execPath) !== digest(nodeTarget)) fs.copyFileSync(process.execPath, nodeTarget);
const bundledMajor = Number(require('node:child_process').execFileSync(nodeTarget, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).trim());
if (bundledMajor !== 22) throw new Error(`内置 Node.js 主版本错误：${bundledMajor}，要求 22。`);
console.log('已准备内置 Node 和伙伴运行依赖；游戏服务端文件由用户提供。');
