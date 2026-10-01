// FML3 握手裸测试：验证 bot 能进 Forge 服务端
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mineflayer = require('mineflayer');
const autoVersionForge = require('./src/utils/forge/client/autoVersionForge.cjs');

const bot = mineflayer.createBot({
  version: false,
  host: '127.0.0.1',
  port: 25565,
  username: 'wbb',
  auth: 'offline'
});

// 挂 FML3 握手处理器（空 options = 自动反射服务端 mod 清单）
autoVersionForge(bot._client, { forgeMods: undefined, channels: undefined });

bot.on('connect', () => console.log('[1] TCP 已连接'));
bot.on('login', () => console.log('[2] 登录成功（FML3 握手通过）'));
bot.on('spawn', () => { console.log('[3] 已进入世界，位置:', bot.entity?.position?.toString()); process.exit(0); });
bot.on('error', (e) => { console.log('[ERR]', e.message?.split('\n')[0]); process.exit(1); });
bot.on('end', (r) => { console.log('[END]', r); process.exit(1); });
setTimeout(() => { console.log('[TIMEOUT] 60秒无进展'); process.exit(1); }, 60000);
