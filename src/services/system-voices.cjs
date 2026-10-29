const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function voiceScript() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'mindcraft', 'native_voice.ps1'),
    path.join(__dirname, '..', '..', 'runtime', 'mindcraft-final', 'native_voice.ps1')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function invokeVoice(args) {
  const script = voiceScript();
  if (!script) throw new Error('未找到内置语音组件，请重新安装minebot。');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, ...args], { windowsHide: true, timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    if (!result.ok) throw new Error(result.error || '语音组件运行失败。');
    return result;
  } catch (error) {
    throw new Error(`Windows 语音不可用：${error.message}`);
  }
}

async function listSystemVoices() {
  const result = await invokeVoice(['-Mode', 'list']);
  return Array.isArray(result.voices) ? result.voices.filter((v) => v && typeof v.name === 'string') : [];
}

async function previewSystemVoice(name) {
  const voices = await listSystemVoices();
  if (name && !voices.some((voice) => voice.name === name)) throw new Error('该声音当前未安装，请刷新声音列表。');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jingban-voice-preview-'));
  const output = path.join(dir, 'preview.wav');
  try {
    const text = Buffer.from('你好，我是你的游戏伙伴，很高兴和你一起冒险。', 'utf8').toString('base64');
    await invokeVoice(['-Mode', 'tts', '-TextBase64', text, '-OutputPath', output, '-Voice', String(name || '')]);
    return `data:audio/wav;base64,${(await fs.promises.readFile(output)).toString('base64')}`;
  } finally {
    await fs.promises.unlink(output).catch(() => {});
    await fs.promises.rmdir(dir).catch(() => {});
  }
}

module.exports = { listSystemVoices, previewSystemVoice, voiceScript };
