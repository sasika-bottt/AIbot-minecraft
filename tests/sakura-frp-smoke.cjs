const assert = require('node:assert/strict');
const { parseLog } = require('../src/services/sakura-frp.cjs');

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
console.log('sakura frp log parser smoke test passed');
