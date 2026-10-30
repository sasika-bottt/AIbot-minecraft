const assert = require('node:assert/strict');
const { parseLog, SakuraFrpService } = require('../src/services/sakura-frp.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tunnels = parseLog(`
2026-10-28 Info Tunnel/123 开始加载隧道配置
frpc[123|Info] 隧道本地端口为 25565, 正在自动监测 Minecraft 局域网游戏
frpc[123|Info] 隧道启动中: [123, tcp]
frpc[123|Info] 使用 >>frp-boy.com:50480<< 连接你的隧道
frpc[123|Info] 隧道启动成功
2026-10-28 Info Tunnel/1234 开始加载隧道配置
frpc[1234|Info] 隧道启动中: [1234, udp]
frpc[1234|Info] 使用 >>frp-boy.com:32594<< 连接你的隧道
frpc[1234|Info] 隧道启动成功
2026-10-28 Info Tunnel/123 frpc 已退出
`);
assert.deepEqual(tunnels.get('123'), { id: '123', protocol: 'tcp', localPort: 25565, address: 'frp-boy.com:50480', running: false });
assert.deepEqual(tunnels.get('1234'), { id: '1234', protocol: 'udp', localPort: null, address: 'frp-boy.com:32594', running: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-frp-test-'));
try {
  fs.mkdirSync(path.join(root, 'Logs'));
  fs.writeFileSync(path.join(root, 'Logs', 'SakuraFrpService.test.log'), `frpc[1|Info] 隧道本地端口为 25565\nfrpc[1|Info] 隧道启动中: [1, tcp]\nfrpc[1|Info] 使用 >>old.example:1<< 连接你的隧道\nfrpc[1|Info] 隧道启动成功\nfrpc[2|Info] 隧道本地端口为 25575\nfrpc[2|Info] 隧道启动中: [2, tcp]\nfrpc[2|Info] 使用 >>new.example:2<< 连接你的隧道\nfrpc[2|Info] 隧道启动成功\n`);
  const service = new SakuraFrpService({ root });
  assert.equal(service.status({ gameLocalPort: 25575 }).game.address, 'new.example:2');
  assert.equal(service.status({ gameLocalPort: 25580 }).game, null);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('sakura frp log parser smoke test passed');

