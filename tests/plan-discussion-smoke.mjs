import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Agent } from '../runtime/mindcraft-final/src/agent/agent.js';
import managerModule from '../src/services/bot-manager.cjs';

const turns = [];
const agent = {
  name: 'ExampleBot', isIdle: () => true,
  history: { add: async (role, content) => turns.push({ role, content }), getHistory: () => turns, save: () => {} },
  prompter: { promptConvo: async () => '可以先规划材料。 !collectBlocks("oak_log", 8)' }
};
const reply = await Agent.prototype.discussBuildPlan.call(agent, '在村庄旁建一座小屋');
assert.equal(reply, '可以先规划材料。');
assert.equal(turns.length, 2);
assert.match(turns[0].content, /不要执行任何命令/);
assert.equal(agent._buildDiscussionBusy, false);
await assert.rejects(Agent.prototype.discussBuildPlan.call({ ...agent, isIdle: () => false }, '需求'), /正在执行任务/);

const requireRuntime = createRequire(new URL('../runtime/mindcraft-final/package.json', import.meta.url));
const { Server } = requireRuntime('socket.io');
const server = http.createServer();
const io = new Server(server);
io.on('connection', (socket) => socket.on('minebot-discuss-plan', (name, text, ack) => {
  assert.equal(name, 'ExampleBot');
  assert.equal(text, '请讨论');
  ack({ ok: true, reply: '已收到，仅讨论。' });
}));
await new Promise((resolve) => server.listen(0, 'localhost', resolve));
const manager = new managerModule.BotManager('unused', {}, {}, { project: fileURLToPath(new URL('../runtime/mindcraft-final/', import.meta.url)) });
manager.child = { exitCode: null };
manager.state = { ...manager.state, ready: true, name: 'ExampleBot' };
manager.mindserverPort = server.address().port;
try { assert.equal(await manager.discussPlan('请讨论'), '已收到，仅讨论。'); }
finally { await new Promise((resolve) => io.close(resolve)); }
console.log('plan discussion handoff smoke test passed');

