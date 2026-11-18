// Fabric registry sync subset for Minecraft 1.21.11. Unknown registries or
// remapped vanilla IDs are rejected: connecting is never evidence that an
// arbitrary modded block/item protocol is implemented.
function decodeRegistry(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 8 * 1024 * 1024) throw new Error('Fabric 注册表数据无效或过大');
  let offset = 0, total = 0;
  function readInt() {
    let value = 0, shift = 0, byte;
    do {
      if (offset >= buffer.length || shift >= 35) throw new Error('Fabric 注册表数据不完整');
      byte = buffer[offset++]; value |= (byte & 127) << shift; shift += 7;
    } while (byte & 128);
    return value;
  }
  function count() { const value = readInt(); if (value < 0 || value > 100000) throw new Error('Fabric 注册表数量异常'); return value; }
  function readString() {
    const size = count();
    if (size > 32767 || offset + size > buffer.length) throw new Error('Fabric 注册表字符串无效');
    const value = buffer.toString('utf8', offset, offset + size); offset += size; return value;
  }
  const registries = [];
  for (let i = 0, groups = count(); i < groups; i++) {
    const namespace = readString() || 'minecraft';
    for (let j = 0, amount = count(); j < amount; j++) {
      const name = `${namespace}:${readString()}`;
      if (offset >= buffer.length) throw new Error('Fabric 注册表属性缺失');
      const flags = buffer[offset++], entries = [];
      let last = 0;
      for (let k = 0, namespaces = count(); k < namespaces; k++) {
        const entryNamespace = readString() || 'minecraft';
        for (let l = 0, bulks = count(); l < bulks; l++) {
          let id = last + readInt() - 1;
          for (let m = 0, size = count(); m < size; m++) {
            id++; if (++total > 100000 || id < 0) throw new Error('Fabric 注册表内容异常');
            entries.push({ namespace: entryNamespace, name: readString(), id });
          }
          last = id;
        }
      }
      registries.push({ name, flags, entries });
    }
  }
  if (offset !== buffer.length) throw new Error('Fabric 注册表存在未识别的数据');
  return registries;
}

function verifyVanillaIds(registries, data) {
  const types = {
    'minecraft:item': Object.values(data.items || {}),
    'minecraft:attribute': Object.values(data.attributes || {}),
    'minecraft:mob_effect': Object.values(data.effects || {})
  };
  const seen = new Set();
  for (const registry of registries) {
    const values = types[registry.name];
    if (!values || seen.has(registry.name)) throw new Error(`伙伴尚不支持同步注册表 ${registry.name}`);
    seen.add(registry.name);
    const vanilla = registry.entries.filter(entry => entry.namespace === 'minecraft');
    if (vanilla.length !== values.length) throw new Error(`注册表 ${registry.name} 的原版条目不完整`);
    const ids = new Set();
    for (const entry of registry.entries) {
      if (ids.has(entry.id)) throw new Error(`注册表 ${registry.name} 存在重复编号`);
      ids.add(entry.id);
      if (entry.namespace !== 'minecraft') {
        if (entry.id < values.length) throw new Error(`模组注册表 ${registry.name} 改写了原版编号`);
        continue;
      }
      let expected;
      if (registry.name === 'minecraft:item') expected = data.itemsByName?.[entry.name]?.id;
      else if (registry.name === 'minecraft:attribute') expected = values.findIndex(value => value.resource === `minecraft:${entry.name}`);
      else {
        const normalized = entry.name === 'unluck' ? 'badluck' : entry.name.replace(/_/g, '').toLowerCase();
        expected = values.findIndex(value => String(value.name).replace(/_/g, '').toLowerCase() === normalized);
      }
      if (expected !== entry.id) throw new Error(`注册表 ${registry.name} 的 ${entry.name} 编号不一致`);
    }
  }
  return registries.reduce((sum, registry) => sum + registry.entries.filter(entry => entry.namespace !== 'minecraft').length, 0);
}

function attachFabricRegistry(bot, version, data) {
  // Other versions may use a different wire format; never guess.
  if (version !== '1.21.11') return;
  const client = bot._client;
  client.on('state', state => {
    if (state === 'configuration') client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from('fabric:registry/sync') });
  });
  client.on('custom_payload', packet => {
    if (client.state !== 'configuration' || packet.channel !== 'fabric:registry/sync') return;
    try {
      const extra = verifyVanillaIds(decodeRegistry(packet.data), data);
      console.log(`Fabric 注册表校验通过；有 ${extra} 个模组条目，伙伴仅保证原版方块及物品行为。`);
      client.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) });
    } catch (error) {
      console.error(`Fabric 注册表不兼容：${error.message}`);
      client.end('Fabric 注册表不兼容，已安全停止伙伴连接');
    }
  });
}
module.exports = { decodeRegistry, verifyVanillaIds, attachFabricRegistry };
