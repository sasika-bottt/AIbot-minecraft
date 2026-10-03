// voice.js — wbb 语音链路
// 说（TTS）：回复文本 → edge-tts(Python CLI) → mp3 → SVC 游戏内 3D 语音
// 听（STT）：玩家语音 PCM → VAD 切片 → ffmpeg 转 16k wav → faster-whisper → 文本 → handleMessage
// 注：JS 版 edge-tts 包被微软 2026 DRM 升级挡死（403），Python 7.2.8 已适配，故走 CLI。
import simplevoice from 'mineflayer-simplevoice/lib/index.js';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// 外部可执行文件：优先用环境变量覆盖，未设置则回退 PATH / 平台默认（便于跨机复用）
const EDGE_TTS_EXE = process.env.EDGE_TTS_EXE || 'edge-tts';
const PYTHON_EXE = process.env.PYTHON_EXE || (process.platform === 'win32' ? 'python' : 'python3');
const FFMPEG_DIR = process.platform === 'win32' ? 'win32-x64'
                 : (process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64');
const FFMPEG_EXE = process.env.FFMPEG_PATH
                 || path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', FFMPEG_DIR,
                              process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const TTS_VOICE = 'zh-CN-XiaoyiNeural'; // 女声·晓伊（活泼少女音）
const TTS_RATE = '+20%';
const MAX_SPEAK_LEN = 200;   // 单次语音最长字符数
const TTS_DIR = path.join(process.cwd(), 'bots', '_tts');
const STT_DIR = path.join(process.cwd(), 'bots', '_stt');

const SEGMENT_SILENCE_MS = 1000; // 静音多久算说完一句话（1.5s→1.0s 提速响应）
const MIN_SEGMENT_MS = 600;      // 太短的片段丢弃（噪音）
const MIN_RMS = 400;             // 音量门限，低于视为静音

let _bot = null;
let _agent = null;
let _connected = false;
let _queue = [];          // TTS 待播报队列（串行）
let _speaking = false;
let _py = null;           // stt_server.py 常驻进程
let _pyReady = false;
let _pyBuf = '';
let _pyWaiters = new Map(); // id -> resolve
let _pyId = 0;
let _sttBusy = false;
let _sttQueue = [];       // 待识别的 {sender, rawPath}
let _tts = null;          // tts_worker.py 常驻进程（省冷启动）
let _ttsReady = false;
let _ttsBuf = '';
let _ttsWaiters = new Map(); // id -> resolve
let _ttsId = 0;

export function cleanForSpeech(text) {
    if (!text) return '';
    const lines = String(text)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('!') && !l.startsWith('```'));
    let out = lines.join(' ');
    if (out.length > MAX_SPEAK_LEN) out = out.slice(0, MAX_SPEAK_LEN) + '……';
    return out;
}

/** 加载语音插件 + 启动识别服务。在 bot spawn 前调用 */
export function loadVoice(bot, agent) {
    _bot = bot;
    _agent = agent;
    try {
        simplevoice.setLoggingLevel(3); // 只留错误，减少刷屏
        bot.loadPlugin(simplevoice.plugin);
        bot.once('voicechat_connect', () => {
            _connected = true;
            console.log('[voice] SVC connected (UDP), bot 可语音');
        });
        bot.on('voicechat_disconnect', () => { _connected = false; });
        console.log('[voice] Simple Voice Chat plugin loaded');
    } catch (e) {
        console.log('[voice] plugin load failed:', e.message);
    }
    if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });
    if (!fs.existsSync(STT_DIR)) fs.mkdirSync(STT_DIR, { recursive: true });

    startSttServer();
    startTtsWorker();
    setupListening();
}

// ================= TTS（说话） =================

function startTtsWorker() {
    try {
        _tts = spawn(PYTHON_EXE, [path.join(process.cwd(), 'tts_worker.py')], {
            cwd: process.cwd(), windowsHide: true,
        });
        _tts.stdout.on('data', (d) => {
            _ttsBuf += d.toString();
            let idx;
            while ((idx = _ttsBuf.indexOf('\n')) >= 0) {
                const line = _ttsBuf.slice(0, idx).trim();
                _ttsBuf = _ttsBuf.slice(idx + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line);
                    const resolve = _ttsWaiters.get(msg.id);
                    if (resolve) { _ttsWaiters.delete(msg.id); resolve(msg); }
                } catch (e) {}
            }
        });
        _tts.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) console.log('[voice][tts]', s.slice(0, 150));
        });
        _tts.on('exit', (code) => {
            console.log('[voice] tts worker exited', code);
            _ttsReady = false;
        });
        _ttsReady = true;
        console.log('[voice] tts worker started');
    } catch (e) {
        console.log('[voice] tts worker start failed:', e.message);
    }
}

/** 常驻 worker 合成一段语音；失败返回 {ok:false} */
function ttsRequest(text, mp3Path) {
    return new Promise((resolve) => {
        if (!_ttsReady || !_tts) return resolve({ ok: false, error: 'tts worker not ready' });
        const id = ++_ttsId;
        _ttsWaiters.set(id, resolve);
        _tts.stdin.write(JSON.stringify({ id, text, out: mp3Path }) + '\n');
        setTimeout(() => { // 30s 超时兜底
            if (_ttsWaiters.has(id)) {
                _ttsWaiters.delete(id);
                resolve({ ok: false, error: 'tts timeout' });
            }
        }, 30000);
    });
}

export function speakVoice(bot, text) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    _queue.push(clean);
    _pump();
}

async function _pump() {
    if (_speaking || !_bot) return;
    _speaking = true;
    try {
        while (_queue.length > 0) {
            const text = _queue.shift();
            if (!_connected) continue;
            const mp3 = path.join(TTS_DIR, `say_${Date.now()}.mp3`);
            // 优先常驻 worker（省 ~1s 冷启动），失败回退一次性 CLI
            let r = await ttsRequest(text, mp3);
            if (!r.ok) {
                await new Promise((resolve, reject) => {
                    execFile(EDGE_TTS_EXE, [
                        '--voice', TTS_VOICE, '--rate=' + TTS_RATE,
                        '--text', text, '--write-media', mp3,
                    ], { timeout: 30000, windowsHide: true }, (err) => err ? reject(err) : resolve());
                });
            }
            await _bot.voicechat.sendAudio(mp3);
            setTimeout(() => { try { fs.unlinkSync(mp3); } catch (e) {} }, 5000);
        }
    } catch (e) {
        console.log('[voice] speak error:', e.message);
    } finally {
        _speaking = false;
    }
}

// ================= STT（听） =================

function startSttServer() {
    try {
        _py = spawn(PYTHON_EXE, [path.join(process.cwd(), 'stt_server.py')], {
            cwd: process.cwd(), windowsHide: true,
        });
        _py.stdout.on('data', (d) => {
            _pyBuf += d.toString();
            let idx;
            while ((idx = _pyBuf.indexOf('\n')) >= 0) {
                const line = _pyBuf.slice(0, idx).trim();
                _pyBuf = _pyBuf.slice(idx + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { continue; }
                if (msg.event === 'ready') {
                    _pyReady = true;
                    console.log('[voice] whisper ready');
                } else if (msg.event) {
                    console.log('[voice] stt:', JSON.stringify(msg));
                } else if (msg.id !== undefined && _pyWaiters.has(msg.id)) {
                    _pyWaiters.get(msg.id)(msg);
                    _pyWaiters.delete(msg.id);
                }
            }
        });
        _py.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) console.log('[voice][py]', s.slice(0, 200));
        });
        _py.on('exit', (code) => {
            console.log('[voice] stt server exited', code);
            _pyReady = false;
        });
    } catch (e) {
        console.log('[voice] stt start failed:', e.message);
    }
}

function sttRequest(wavPath) {
    return new Promise((resolve) => {
        if (!_pyReady || !_py) return resolve({ ok: false, error: 'stt not ready' });
        const id = ++_pyId;
        _pyWaiters.set(id, resolve);
        _py.stdin.write(JSON.stringify({ id, wav: wavPath }) + '\n');
        setTimeout(() => { // 60s 超时兜底
            if (_pyWaiters.has(id)) {
                _pyWaiters.delete(id);
                resolve({ ok: false, error: 'stt timeout' });
            }
        }, 60000);
    });
}

/** 玩家声音监听：按 sender 累积 PCM，静音超时切片送识别 */
function setupListening() {
    const buffers = new Map(); // sender -> { chunks: [], total: 0, timer: null }
    _bot.on('voicechat_player_sound', (data) => {
        const sender = data.sender || 'unknown';
        const pcm = data.data;
        if (!pcm || pcm.length < 100) return;
        // 音量门限：过滤静音/噪声
        let sum = 0, n = pcm.length >> 1;
        for (let i = 0; i + 1 < pcm.length; i += 2) {
            sum += pcm.readInt16LE(i) ** 2;
        }
        const rms = Math.sqrt(sum / Math.max(1, n));
        let entry = buffers.get(sender);
        if (!entry) {
            entry = { chunks: [], total: 0, timer: null };
            buffers.set(sender, entry);
        }
        if (rms >= MIN_RMS) {
            entry.chunks.push(pcm);
            entry.total += pcm.length;
        }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            buffers.delete(sender);
            if (entry.total < MIN_SEGMENT_MS * 96) return; // 48kHz*2字节 → 96 bytes/ms
            finishSegment(sender, Buffer.concat(entry.chunks));
        }, SEGMENT_SILENCE_MS);
    });
}

function playerName(uuid) {
    try {
        for (const [name, p] of Object.entries(_bot.players || {})) {
            if (p.uuid === uuid) return name;
        }
    } catch (e) {}
    return 'voice_' + String(uuid).slice(0, 6);
}

function finishSegment(sender, pcmBuf) {
    _sttQueue.push({ sender, pcmBuf });
    _drainStt();
}

async function _drainStt() {
    if (_sttBusy || !_pyReady) return; // 没就绪就丢（保持简单）
    _sttBusy = true;
    try {
        while (_sttQueue.length > 0) {
            const { sender, pcmBuf } = _sttQueue.shift();
            const stamp = Date.now();
            const rawPath = path.join(STT_DIR, `in_${stamp}.raw`);
            const wavPath = path.join(STT_DIR, `in_${stamp}.wav`);
            fs.writeFileSync(rawPath, pcmBuf);
            // 48kHz s16le 单声道 → 16kHz wav
            await new Promise((resolve, reject) => {
                execFile(FFMPEG_EXE, ['-y', '-f', 's16le', '-ar', '48000', '-ac', '1',
                    '-i', rawPath, '-ar', '16000', '-ac', '1', wavPath],
                    { timeout: 15000, windowsHide: true }, (err) => err ? reject(err) : resolve());
            });
            try { fs.unlinkSync(rawPath); } catch (e) {}
            const res = await sttRequest(wavPath);
            try { fs.unlinkSync(wavPath); } catch (e) {}
            if (res.ok && res.text && res.text.length >= 2) {
                const name = playerName(sender);
                console.log(`[voice] heard ${name}: ${res.text}`);
                // 交给 agent 处理（同聊天消息路径）
                if (_agent && typeof _agent.handleMessage === 'function') {
                    _agent.handleMessage(name, res.text).catch((e) =>
                        console.log('[voice] handle error:', e.message));
                }
            } else if (res.ok) {
                console.log('[voice] heard (empty/skip)');
            } else {
                console.log('[voice] stt error:', res.error);
            }
        }
    } catch (e) {
        console.log('[voice] stt pipeline error:', e.message);
    } finally {
        _sttBusy = false;
        if (_sttQueue.length > 0) _drainStt(); // 若期间有新片段继续
    }
}
