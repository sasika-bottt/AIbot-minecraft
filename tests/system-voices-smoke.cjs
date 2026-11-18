const assert = require('node:assert/strict');
const { listSystemVoices, previewSystemVoice } = require('../src/services/system-voices.cjs');

async function main() {
  if (process.platform !== 'win32') return;
  const voices = await listSystemVoices();
  assert.ok(Array.isArray(voices));
  const chinese = voices.filter((voice) => /^zh(?:-|$)/i.test(voice.culture));
  for (const voice of chinese) {
    const result = await previewSystemVoice(voice.name);
    assert.match(result, /^data:audio\/wav;base64,UklGR/);
    assert.ok(result.length > 1000, `语音试听为空：${voice.label || voice.name}`);
  }
  await assert.rejects(previewSystemVoice('不存在的测试声音'), /未安装/);
  console.log(`system voices smoke test passed (${chinese.length} Chinese voices)`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
