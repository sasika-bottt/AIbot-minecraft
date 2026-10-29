const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/services/config-store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingban-config-'));
try {
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
  const store = new ConfigStore(root, safeStorage);
  const saved = store.save({ network: { gameLocalPort: 99999, voiceLocalPort: 0 }, persona: { name: 'bbb' } });
  assert.equal(saved.network.gameLocalPort, 25565);
  assert.equal(saved.network.voiceLocalPort, 24454);
  fs.writeFileSync(store.configPath, '{broken json', 'utf8');
  const recovered = store.load();
  assert.equal(recovered.persona.name, '');
  assert.match(store.consumeRecoveryNotice(), /无法读取/);
  assert.equal(fs.readdirSync(store.dir).some((name) => name.startsWith('config.corrupt-')), true);
  console.log('config recovery smoke test passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
