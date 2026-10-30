const fs = require('node:fs');
const path = require('node:path');

function validateSkin(source, playerName) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(String(playerName || ''))) throw new Error('请先填写 1–16 位英文字母、数字或下划线组成的伙伴游戏名称。');
  if (!source || path.extname(source).toLowerCase() !== '.png') throw new Error('请先选择或生成 PNG 皮肤。');
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('皮肤文件无效或超过 2 MB。');
  const data = fs.readFileSync(source);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('皮肤不是有效的 PNG 图片。');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width !== 64 || ![32, 64].includes(height)) throw new Error('请选择 64×64 或 64×32 像素的 Minecraft 皮肤。');
  return data;
}

function exportSkin(source, playerName, destination) {
  const data = validateSkin(source, playerName);
  if (!destination || path.extname(destination).toLowerCase() !== '.png') throw new Error('请选择 PNG 导出位置。');
  if (path.basename(destination).toLowerCase() !== `${playerName}.png`.toLowerCase()) throw new Error(`请保留文件名 ${playerName}.png，皮肤模组需要用它匹配伙伴名称。`);
  try { fs.writeFileSync(destination, data, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('该位置已有同名皮肤。请先备份或手动移走原文件，再重试。'); throw error; }
  return destination;
}

module.exports = { validateSkin, exportSkin };

