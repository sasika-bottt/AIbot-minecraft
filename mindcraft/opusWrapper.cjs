// opusWrapper.cjs — @discordjs/opus 原生模块不可用（node 22 无预编译包且无 VS 编译环境）时，
// 用纯 JS 的 opusscript 提供相同接口：new OpusEncoder(rate, channels) / setBitrate / encode / decode
// opusscript 实际 API：new OpusScript(rate, channels, app)；encode(buf, frameSize)；decode(buf)
const OpusScript = require('opusscript');
const FRAME_DURATION_MS = 20; // SVC 固定 20ms 帧（StoredData.FRAME_DURATION_MS）

class OpusEncoder {
    constructor(rate, channels) {
        this._rate = rate;
        this._frameSize = Math.floor(rate * FRAME_DURATION_MS / 1000); // 48000Hz*20ms = 960
        this._enc = new OpusScript(rate, channels, OpusScript.Application.VOIP);
    }
    setBitrate(v) {
        try { this._enc.setBitrate(v); } catch (e) { /* 不支持则忽略 */ }
    }
    encode(pcmBuf) {
        // 输入 PCM (16-bit)，输出 opus 数据
        return Buffer.from(this._enc.encode(pcmBuf, this._frameSize));
    }
    decode(opusBuf) {
        // 输入 opus 数据，输出 PCM (16-bit)
        return Buffer.from(this._enc.decode(opusBuf));
    }
}

module.exports = { OpusEncoder };
