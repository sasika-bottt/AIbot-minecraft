// Explicitly invoked only; sends one small request and may consume credits.
const os = require('node:os');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');
(async () => {
  const service = new WorkBuddyService(os.tmpdir());
  try {
    const models = await service.models();
    const model = models.find((item) => item.id === 'hy3' && item.free);
    if (!model) throw new Error('已验证的零积分模型不可用；没有发送请求。');
    const gateway = await service.startGateway();
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16, stream: true }),
      signal: AbortSignal.timeout(45000)
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}: ${body.slice(0, 250)}`);
    if (!/"(?:content|delta)"\s*:/.test(body)) throw new Error('响应没有可识别的模型内容。');
    console.log(`WorkBuddy live stream received; model=${model.id}, listed_credits=${model.credits}`);
  } finally { await service.stopGateway(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
