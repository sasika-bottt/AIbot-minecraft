// Voice integration for the companion.
// 说（TTS）：回复文本 → edge-tts(Python CLI) → mp3 → SVC 游戏内 3D 语音
// 听（STT）：玩家语音 PCM → VAD 切片 → ffmpeg 转 16k wav → faster-whisper → 文本 → handleMessage
// 注：JS 版 edge-tts 包被微软 2026 DRM 升级挡死（403），Python 7.2.8 已适配，故走 CLI。
import simplevoice from 'mineflayer-simplevoice/lib/index.js';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import settings from './settings.js';

const RUNTIME_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const EDGE_TTS_EXE = process.env.MINDCRAFT_EDGE_TTS
    || '';
const PYTHON_EXE = process.env.MINDCRAFT_PYTHON
    || '';
const VOICE_WORKERS_ENABLED = process.env.MINDCRAFT_VOICE_WORKERS !== '0'
    && fs.existsSync(PYTHON_EXE);
const NATIVE_VOICE_SCRIPT = path.join(RUNTIME_ROOT, 'native_voice.ps1');
const NATIVE_VOICE_ENABLED = process.platform === 'win32' && fs.existsSync(NATIVE_VOICE_SCRIPT);
const FFMPEG_EXE = path.join(RUNTIME_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
// ⚠️ 标准普通话女声只有 Xiaoxiao / Xiaoyi / Xiaoxuan 三个。
//    Xiaobei = 东北话、Xiaoni = 陕西话（虽无 liaoning/shaanxi 前缀，实为方言），勿用。
const TTS_VOICE = 'zh-CN-XiaoyiNeural'; // 标准普通话女声（官方标 Cartoon，动漫少女音）
const TTS_RATE = '+20%';                // 语速
const TTS_PITCH = '+20Hz';              // 升调：基频约 356Hz，甜美且高频占比最低档（0.0922）
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
let _nativeVoice = false;

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

    if (NATIVE_VOICE_ENABLED) {
        _nativeVoice = true;
        _pyReady = true;
        setupListening();
        console.log('[voice] 已启用 Windows 原生中文语音，无需 Python');
    } else if (VOICE_WORKERS_ENABLED) {
        startSttServer();
        startTtsWorker();
        setupListening();
    } else {
        console.log(`[voice] Python 语音环境不可用，已降级为文字对话：${PYTHON_EXE}`);
    }
}

// ================= TTS（说话） =================

function startTtsWorker() {
    try {
        _tts = spawn(PYTHON_EXE, [path.join(RUNTIME_ROOT, 'tts_worker.py')], {
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
        _tts.on('error', (error) => {
            console.log('[voice] tts worker unavailable:', error.message);
            _ttsReady = false;
            _tts = null;
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
            const extension = _nativeVoice ? 'wav' : 'mp3';
            const audioPath = path.join(TTS_DIR, `say_${Date.now()}.${extension}`);
            let r;
            if (_nativeVoice) {
                r = await nativeTtsRequest(text, audioPath);
            } else {
                // 优先常驻 worker（省 ~1s 冷启动），失败回退一次性 CLI
                r = await ttsRequest(text, audioPath);
            }
            if (!r.ok && !_nativeVoice) {
                await new Promise((resolve, reject) => {
                    execFile(EDGE_TTS_EXE, [
                        '--voice', TTS_VOICE, '--rate=' + TTS_RATE, '--pitch=' + TTS_PITCH,
                        '--text', text, '--write-media', audioPath,
                    ], { timeout: 30000, windowsHide: true }, (err) => err ? reject(err) : resolve());
                });
            }
            if (!r.ok) throw new Error(r.error || '语音合成失败');
            await _bot.voicechat.sendAudio(audioPath);
            setTimeout(() => { try { fs.unlinkSync(audioPath); } catch (e) {} }, 5000);
        }
    } catch (e) {
        console.log('[voice] speak error:', e.message);
    } finally {
        _speaking = false;
    }
}

function runNativeVoice(args, timeout) {
    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', NATIVE_VOICE_SCRIPT, ...args],
        { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
            const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
            try {
                const result = JSON.parse(lines.at(-1) || '{}');
                if (error && result.ok !== false) result.ok = false;
                if (!result.ok && !result.error) result.error = String(stderr || error?.message || 'Windows 语音调用失败').trim();
                resolve(result);
            } catch {
                resolve({ ok: false, error: String(stderr || error?.message || 'Windows 语音返回无法解析').trim() });
            }
        });
    });
}

function nativeTtsRequest(text, wavPath) {
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    return runNativeVoice(['-Mode', 'tts', '-TextBase64', encoded, '-OutputPath', wavPath, '-Voice', String(settings.voice_name || '')], 30000);
}

function nativeSttRequest(wavPath) {
    return runNativeVoice(['-Mode', 'stt', '-InputPath', wavPath], 30000);
}

// ================= STT（听） =================

function startSttServer() {
    try {
        _py = spawn(PYTHON_EXE, [path.join(RUNTIME_ROOT, 'stt_server.py')], {
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
        _py.on('error', (error) => {
            console.log('[voice] stt server unavailable:', error.message);
            _pyReady = false;
            _py = null;
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
    if (_nativeVoice) return nativeSttRequest(wavPath);
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
    const onPlayerSound = (data) => {
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
    };
    _bot.on('voicechat_player_sound', onPlayerSound);
    _bot.on('voicechat_group_sound', onPlayerSound);
}

function playerName(uuid) {
    try {
        if (_bot.players && Object.prototype.hasOwnProperty.call(_bot.players, String(uuid))) return String(uuid);
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

