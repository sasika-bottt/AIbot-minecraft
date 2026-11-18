import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-workbuddy-retry-'));
const server = http.createServer((req, res) => {
  server.calls = (server.calls || 0) + 1;
  if (server.calls === 1) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temporary upstream failure', code: 502 } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"id":"retry-test","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{"content":"恢复"},"finish_reason":null}]}\n\n');
  if (server.calls === 2) {
    // Simulate an upstream connection that closes cleanly before a final chunk.
    res.end();
    return;
  }
  res.write('data: {"id":"retry-test","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{"content":"成功"},"finish_reason":null}]}\n\n');
  res.write('data: {"id":"retry-test","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end('data: [DONE]\n\n');
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(temporary, 'workbuddy.json'), JSON.stringify({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'local-test-token'
  }));
  process.env.WORKBUDDY_SHIM_DIR = temporary;
  const { WorkBuddy } = await import('../runtime/mindcraft-final/src/models/workbuddy.js');
  const model = new WorkBuddy('mock', '', { workbuddy_max_retries: 2, workbuddy_retry_delay_ms: 0 });
  const answer = await model.sendRequest([{ role: 'user', content: '测试重试' }], '测试系统消息');
  assert.equal(answer, '恢复成功');
  assert.equal(server.calls, 3);
  console.log('workbuddy retry and incomplete-stream smoke test passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
