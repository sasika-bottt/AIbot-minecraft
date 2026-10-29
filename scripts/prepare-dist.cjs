const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows 安装包需要在 Windows x64 上使用 Node.js 构建。');
}
const agentDeps = path.join(root, 'runtime', 'mindcraft-final', 'node_modules', 'mineflayer');
if (!fs.existsSync(agentDeps)) {
  throw new Error('缺少伙伴运行依赖，请先执行 npm --prefix runtime/mindcraft-final ci --omit=dev。');
}
const core = path.join(root, 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js');
if (!fs.existsSync(core)) throw new Error('缺少 WorkBuddy 通道组件，请先执行 npm ci。');
fs.copyFileSync(process.execPath, path.join(root, 'runtime', 'node.exe'));
console.log('已准备内置 Node 和伙伴运行依赖；游戏服务端文件由用户提供。');
