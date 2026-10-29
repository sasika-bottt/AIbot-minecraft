const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { WorkBuddyService } = require('../src/services/workbuddy.cjs');

async function main() {
  const service = new WorkBuddyService(path.join(__dirname, '.tmp-profile'));
  const candidates = service.moduleCandidates();
  const bundled = path.join(__dirname, '..', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-SJaZ33tR.js');
  assert.equal(path.resolve(candidates[0]), path.resolve(bundled));
  const core = await service.loadCore();
  assert.equal(typeof core.WorkBuddyUpstreamClient, 'function');
  assert.equal(typeof core.WorkBuddyCredentialStore, 'function');
  assert.equal(typeof core.prepareChatBody, 'function');
  const credits = new WorkBuddyService(path.join(__dirname, '.tmp-profile'));
  credits.modelsCache = [{ id: 'mock-workbuddy-model' }];
  credits.ensureRuntime = async () => ({
    core: { prepareChatBody: (raw) => JSON.parse(raw) },
    store: { resolve: async () => ({ marker: 'test-credential' }) },
    client: { chatStream: async (credential, body) => {
      assert.equal(credential.marker, 'test-credential');
      assert.equal(body.model, 'mock-workbuddy-model');
      return { ok: true, response: new Response('data: test\n\ndata: [DONE]\n\n') };
    } }
  });
  try {
    const gateway = await credits.startGateway();
    const url = `${gateway.baseUrl}/v1/chat/completions`;
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ model: 'mock-workbuddy-model', messages: [{ role: 'user', content: 'test' }] }) };
    assert.equal((await fetch(url, { ...request, headers: { ...request.headers, Authorization: 'Bearer invalid' } })).status, 401);
    const response = await fetch(url, request);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: test/);
  } finally { await credits.stopGateway(); }
  const denied = new WorkBuddyService(path.join(__dirname, '.tmp-profile'));
  denied.ensureRuntime = async () => { throw new Error('the WorkBuddy key helper exited with code EACCES'); };
  const status = await denied.status();
  assert.match(status.reason, /以管理员身份运行/);
  const deniedByStore = new WorkBuddyService(path.join(__dirname, '.tmp-profile'));
  deniedByStore.ensureRuntime = async () => ({ store: { status: async () => ({ state: 'error', reason: 'the WorkBuddy key helper exited with code EACCES' }), resolvedDesktopAuthPath: async () => '' } });
  const storeStatus = await deniedByStore.status();
  assert.match(storeStatus.reason, /以管理员身份运行/);
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.headers.authorization, 'Bearer own-key');
    assert.equal(body.model, 'own-model');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = new WorkBuddyService(path.join(__dirname, '.tmp-profile'));
  try {
    const gateway = await proxy.startApiGateway({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, modelId: 'own-model', apiKey: 'own-key' });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.token}` },
      body: JSON.stringify({ model: 'placeholder', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(response.ok, true);
    assert.equal((await response.json()).choices[0].message.content, 'ok');
  } finally {
    await proxy.stopGateway();
    await new Promise((resolve) => upstream.close(resolve));
  }
  console.log('workbuddy bundled-core smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
