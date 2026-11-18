const crypto = require('node:crypto');

// Simple Voice Chat protocol 20 uses AES-GCM (12-byte nonce, 16-byte tag).
// Adapt the existing single-agent voice transport without editing node_modules.
function enableProtocol20(encryption, storedData) {
  function key() {
    const secret = storedData.secretPacketData?.secret;
    if (!secret) throw new Error('语音密钥尚未建立');
    const result = Buffer.alloc(16);
    result.writeBigInt64BE(secret.mostSignificantBits, 0);
    result.writeBigInt64BE(secret.leastSignificantBits, 8);
    return result;
  }
  encryption.encrypt = data => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-128-gcm', key(), iv);
    return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  };
  encryption.decrypt = data => {
    if (!Buffer.isBuffer(data) || data.length < 28) throw new Error('语音数据包不完整');
    const decipher = crypto.createDecipheriv('aes-128-gcm', key(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
  };
}
module.exports = { enableProtocol20 };
