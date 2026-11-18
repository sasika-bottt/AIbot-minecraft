const net = require('node:net');
function varInt(value) { const bytes = []; let n = value >>> 0; do { let b = n & 127; n >>>= 7; if (n) b |= 128; bytes.push(b); } while (n); return Buffer.from(bytes); }
function readVarInt(data, start = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) { if (start + i >= data.length) return null; const b = data[start + i]; value |= (b & 127) << (7 * i); if (!(b & 128)) return { value: value >>> 0, bytes: i + 1 }; }
  throw new Error('Minecraft 状态包长度无效。');
}
function probeServer(port, host = '127.0.0.1', timeout = 3500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }); let pending = Buffer.alloc(0), finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout, () => finish(new Error('游戏服务器状态查询超时。')));
    socket.once('error', error => finish(error)); socket.once('end', () => finish(new Error('游戏服务器提前关闭了状态连接。')));
    socket.once('connect', () => {
      const hostname = Buffer.from(host), portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
      const hello = Buffer.concat([varInt(0), varInt(-1), varInt(hostname.length), hostname, portBytes, varInt(1)]);
      socket.write(Buffer.concat([varInt(hello.length), hello, Buffer.from([1, 0])]));
    });
    socket.on('data', data => {
      try {
        if (pending.length + data.length > 1024 * 1024) throw new Error('游戏服务器状态包过大。');
        pending = Buffer.concat([pending, data]); const packet = readVarInt(pending); if (!packet) return;
        if (packet.value > 1024 * 1024) throw new Error('游戏服务器状态包过大。');
        if (pending.length < packet.bytes + packet.value) return;
        const id = readVarInt(pending, packet.bytes); if (!id || id.value !== 0) throw new Error('端口响应不是 Minecraft 状态。');
        const length = readVarInt(pending, packet.bytes + id.bytes);
        if (!length || length.value > packet.value - id.bytes - length.bytes) throw new Error('Minecraft 状态字符串长度无效。');
        const start = packet.bytes + id.bytes + length.bytes;
        const value = JSON.parse(pending.subarray(start, start + length.value).toString('utf8'));
        if (!value.version || !Number.isInteger(value.version.protocol) || !value.players) throw new Error('端口未返回有效的 Minecraft 服务器状态。');
        finish(null, { version: value.version.name, protocol: value.version.protocol, online: value.players.online });
      } catch (error) { finish(error); }
    });
  });
}
module.exports = { probeServer, varInt };
