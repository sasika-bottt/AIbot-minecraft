import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { setSettings } from '../runtime/mindcraft-final/src/agent/settings.js';
import { loadVoice, speakVoice } from '../runtime/mindcraft-final/src/agent/voice.js';
import voices from '../src/services/system-voices.cjs';

if (process.platform === 'win32') {
  const available = await voices.listSystemVoices();
  const target = available.find((voice) => voice.culture === 'zh-CN' && voice.name.startsWith('onecore:'));
  if (target) {
    setSettings({ voice_name: target.name });
    const bot = new EventEmitter();
    bot.loadPlugin = () => {};
    let audio;
    bot.voicechat = { sendAudio: async (filename) => { audio = readFileSync(filename); } };
    loadVoice(bot, {});
    bot.emit('voicechat_connect');
    speakVoice(bot, '你好，我是游戏伙伴。');
    const deadline = Date.now() + 30000;
    while (!audio && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(audio?.length > 1000, '伙伴应生成语音并交给语音模组');
    assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
    console.log(`voice pipeline smoke test passed (${target.label})`);
  } else console.log('voice pipeline skipped: no Chinese OneCore voice');
}
