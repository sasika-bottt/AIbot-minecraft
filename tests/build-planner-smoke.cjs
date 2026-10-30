const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { BuildPlanner } = require('../src/services/build-planner.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockmate-planner-'));
  let lastRequest;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      lastRequest = parsed;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `已收到：${parsed.messages.at(-1).content}` } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    let config = {
      model: { channel: 'api', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'local-test' },
      behavior: { buildStewardMode: 'manual' }
    };
    const configStore = {
      load: () => structuredClone(config),
      save: (next) => { config = structuredClone(next); return structuredClone(config); },
      readApiKey: () => 'local-test-key'
    };
    const planner = new BuildPlanner(root, configStore, null);
    let state = planner.setMode('admin');
    assert.equal(state.mode, 'admin');
    assert.equal(config.behavior.buildStewardMode, 'admin');
    state = await planner.send('建造一个 20 乘 15 的中世纪旅馆');
    assert.equal(state.messages.length, 2);
    assert.match(state.messages.at(-1).content, /中世纪旅馆/);
    assert.equal(planner.load().messages.length, 2);
    assert.match(lastRequest.messages[0].content, /管理员模式/);
    planner.setMode('manual');
    assert.equal(planner.load().messages.length, 0);
    await assert.rejects(() => planner.survivalBlueprint(), /先在对话中/);
    planner.save({ mode:'manual', messages:[{role:'user', content:'主世界 x=0 y=64 z=0 建泥土方块，背包供料。'}] });
    planner.complete = async () => '```json\n{"dimension":"minecraft:overworld","bounds":{"min":{"x":0,"y":64,"z":0},"max":{"x":0,"y":64,"z":0}},"blocks":[{"x":0,"y":64,"z":0,"name":"dirt"}],"sources":[]}\n```';
    assert.equal((await planner.survivalBlueprint()).blocks[0].name, 'dirt');
    planner.complete = async () => '{"error":"缺少坐标"}';
    await assert.rejects(() => planner.survivalBlueprint(), /缺少坐标/);
    planner.setMode('admin');
    assert.equal(planner.load().messages.length, 2);
    console.log('build planner smoke test passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
