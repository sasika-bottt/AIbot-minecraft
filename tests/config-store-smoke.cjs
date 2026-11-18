const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/services/config-store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingban-config-'));
try {
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
  const store = new ConfigStore(root, safeStorage);
  const saved = store.save({ network: { gameLocalPort: 99999, voiceLocalPort: 0 }, persona: { name: 'SampleBot' } });
  assert.equal(saved.network.gameLocalPort, 25565);
  assert.equal(saved.network.voiceLocalPort, 24454);
  store.save({ server: { administrators: ['CurrentAdmin'], revokedAdministrators: ['RemovedAdmin'] } });
  const staleSaved = store.saveClientConfig({ server: { administrators: ['RemovedAdmin'], revokedAdministrators: [] } });
  assert.deepEqual(staleSaved.server.administrators, ['CurrentAdmin']);
  assert.deepEqual(staleSaved.server.revokedAdministrators, ['RemovedAdmin'], '旧窗口保存不得撤销已经生效的撤权记录');
  store.save({ ...staleSaved, persona: { name: 'RestoredBot' } });
  store.save({ ...staleSaved, persona: { name: 'LastChange' } });
  fs.writeFileSync(store.configPath, '{broken json', 'utf8');
  const recovered = store.load();
  assert.equal(recovered.persona.name, 'RestoredBot');
  assert.deepEqual(recovered.server.administrators, ['CurrentAdmin']);
  assert.equal(store.load().persona.name, 'RestoredBot', '恢复的配置必须持久写回');
  assert.match(store.consumeRecoveryNotice(), /无法读取/);
  assert.equal(fs.readdirSync(store.dir).some((name) => name.startsWith('config.corrupt-')), true);
  fs.writeFileSync(store.configPath, JSON.stringify({ game: null }));
  assert.equal(store.load().persona.name, 'RestoredBot', '结构损坏也应使用有效备份');
  fs.unlinkSync(store.configPath);
  assert.equal(store.load().persona.name, 'RestoredBot', '中断替换导致主配置缺失时应恢复');
  fs.writeFileSync(store.configPath, '[]'); fs.writeFileSync(store.previousPath, '{bad');
  assert.equal(store.load().persona.name, '', '两份均损坏时安全回到空白配置');
  assert.throws(() => store.save({ network: [] }), /配置分组/);
  console.log('config recovery smoke test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
