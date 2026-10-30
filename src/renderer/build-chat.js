const messagesNode = document.getElementById('messages');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const clearButton = document.getElementById('clear');
const statusNode = document.getElementById('status');
const errorNode = document.getElementById('error');
const modeNote = document.getElementById('mode-note');
const executeButton = document.getElementById('execute');
const discussButton = document.getElementById('discuss-agent');
const survivalControls = document.getElementById('survival-controls');
const survivalStatusNode = document.getElementById('survival-status');
const previewButton = document.getElementById('survival-preview');
const stopSurvivalButton = document.getElementById('survival-stop');
const resumeSurvivalButton = document.getElementById('survival-resume');
const blueprintDialog = document.getElementById('blueprint-dialog');
const blueprintJson = document.getElementById('blueprint-json');
const blueprintSummary = document.getElementById('blueprint-summary');
const blueprintDetails = document.getElementById('blueprint-details');
const startSurvivalButton = document.getElementById('start-survival');
let resuming = false;
const materialNames = { dirt:'泥土', cobblestone:'圆石', stone:'石头', oak_log:'橡木原木', oak_planks:'橡木木板', spruce_log:'云杉原木', spruce_planks:'云杉木板', birch_log:'白桦原木', birch_planks:'白桦木板', jungle_log:'丛林原木', jungle_planks:'丛林木板', acacia_log:'金合欢原木', acacia_planks:'金合欢木板', dark_oak_log:'深色橡木原木', dark_oak_planks:'深色橡木木板', bricks:'砖块', stone_bricks:'石砖' };
const label = name => materialNames[name] || String(name || '未知');
const coordinates = p => `${p?.x}, ${p?.y}, ${p?.z}`;
function updateBlueprintSummary() {
  try {
    const p = JSON.parse(blueprintJson.value);
    if (!Array.isArray(p.blocks) || !Array.isArray(p.sources) || !p.bounds?.min || !p.bounds?.max) throw new Error('格式不完整');
    const dimension = ({'minecraft:overworld':'主世界', 'minecraft:the_nether':'下界', 'minecraft:the_end':'末地'})[p.dimension] || String(p.dimension || '未指定');
    const blocks = p.blocks.map(b => `  ${coordinates(b)}  ${label(b.name)}`).join('\n');
    const sources = p.sources.map(s => `  ${coordinates(s)}  ${label(s.name)}${s.product && s.product !== s.name ? ` → ${label(s.product)}` : ''}`).join('\n');
    const areas = Array.isArray(p.harvestAreas) ? p.harvestAreas.map(a => `  ${coordinates(a.min)} 至 ${coordinates(a.max)}`).join('\n') : '';
    const unloaded = Number(p.scanUnloaded) > 0 ? `\n有 ${p.scanUnloaded} 个位置尚未加载，扫描结果可能不完整。` : '';
    blueprintSummary.textContent = `世界：${dimension}\n施工范围：${coordinates(p.bounds.min)} 至 ${coordinates(p.bounds.max)}${areas ? `\n\n扫描范围：\n${areas}${unloaded}` : ''}\n\n逐块放置（${p.blocks.length} 个）：\n${blocks || '  无'}\n\n允许挖掘的采集点（${p.sources.length} 个）：\n${sources || '  没有采集点，只使用伙伴背包中的材料。'}`;
    startSurvivalButton.disabled = false;
  } catch { blueprintSummary.textContent = '计划格式无效，请检查详细坐标。'; startSurvivalButton.disabled = true; }
}
blueprintJson.addEventListener('input', updateBlueprintSummary);
function showBlueprint(plan, resume) {
  resuming = resume; blueprintJson.readOnly = resume; blueprintDetails.open = false;
  blueprintJson.value = JSON.stringify(plan, null, 2); blueprintJson.scrollTop = 0;
  updateBlueprintSummary(); blueprintDialog.showModal(); blueprintSummary.scrollTop = 0;
}
const modeButtons = [...document.querySelectorAll('[data-mode]')];

const MODE_COPY = {
  manual: '生存建造试用：仅支持部分普通方块和原木合成木板。复杂材料、楼梯、门及模组方块暂不支持。',
  admin: '当前为管理员模式：仅在备份、限定坐标范围并由你确认后，执行桥才可批量生成或修改建筑。'
};

function showError(message = '') {
  errorNode.textContent = message;
  errorNode.classList.toggle('hidden', !message);
}

function render(state) {
  modeButtons.forEach((button) => button.classList.toggle('selected', button.dataset.mode === state.mode));
  modeNote.textContent = MODE_COPY[state.mode] || MODE_COPY.manual;
  executeButton.classList.toggle('hidden', state.mode !== 'admin');
  discussButton.classList.toggle('hidden', state.mode !== 'manual');
  survivalControls.classList.toggle('hidden', state.mode !== 'manual');
  messagesNode.replaceChildren();
  if (!state.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('strong');
    title.textContent = '还没有建造需求';
    empty.append(title, document.createTextNode('直接输入你的想法。需求不必一次说完，伙伴会记住上下文并继续澄清。'));
    messagesNode.append(empty);
  } else {
    for (const message of state.messages) {
      const bubble = document.createElement('article');
      bubble.className = `message ${message.role === 'assistant' ? 'assistant' : 'user'}`;
      bubble.textContent = message.content;
      const time = document.createElement('small');
      time.textContent = message.role === 'assistant' ? 'minebot' : '我';
      bubble.append(time);
      messagesNode.append(bubble);
    }
  }
  messagesNode.scrollTop = messagesNode.scrollHeight;
  statusNode.textContent = state.updatedAt ? '已自动保存对话' : '对话会自动保存在本机';
}

async function send() {
  const text = input.value.trim();
  if (!text || sendButton.disabled) return;
  showError();
  sendButton.disabled = true;
  sendButton.textContent = '伙伴正在思考…';
  statusNode.textContent = '正在澄清建造需求';
  try {
    const state = await window.whale.sendBuildMessage(text);
    input.value = '';
    render(state);
  } catch (error) {
    showError(error.message || String(error));
    const state = await window.whale.buildPlannerState();
    render(state);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = '发送给伙伴';
    input.focus();
  }
}

sendButton.addEventListener('click', send);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    send();
  }
});
clearButton.addEventListener('click', async () => {
  if (!window.confirm('确定清空当前建造对话吗？')) return;
  showError();
  render(await window.whale.clearBuildConversation());
});
discussButton.addEventListener('click', async () => {
  showError();
  discussButton.disabled = true; sendButton.disabled = true; clearButton.disabled = true;
  modeButtons.forEach((button) => { button.disabled = true; });
  statusNode.textContent = '正在请游戏中的伙伴讨论；不会自动执行施工';
  try { render(await window.whale.discussWithAgent()); }
  catch (error) { showError(error.message || String(error)); }
  finally { discussButton.disabled = false; sendButton.disabled = false; clearButton.disabled = false; modeButtons.forEach((button) => { button.disabled = false; }); }
});
executeButton.addEventListener('click', async () => {
  if (!window.confirm('minebot将先保存完整世界备份，再执行方案中列出的受控建造命令。确认继续吗？')) return;
  showError();
  executeButton.disabled = true;
  try {
    const result = await window.whale.executeAdminBuild();
    statusNode.textContent = `${result.message} 备份：${result.backupPath}`;
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    executeButton.disabled = false;
  }
});
async function refreshSurvival() {
  try {
    const result = await window.whale.survivalStatus();
    const s = result.agent;
    survivalStatusNode.textContent = `施工状态：${s.message || s.phase}${s.total ? `（${s.completed}/${s.total}）` : ''}`;
    resumeSurvivalButton.disabled = !result.job || ['starting', 'ready', 'building', 'collecting'].includes(s.phase);
    stopSurvivalButton.disabled = !['starting', 'ready', 'building', 'collecting'].includes(s.phase);
  } catch { survivalStatusNode.textContent = '施工状态暂不可用'; }
}
previewButton.addEventListener('click', async () => {
  showError(); previewButton.disabled = true;
  try {
    const plan = await window.whale.generateSurvivalBlueprint();
    showBlueprint(plan, false);
  } catch (error) { showError(error.message || String(error)); }
  finally { previewButton.disabled = false; }
});
resumeSurvivalButton.addEventListener('click', async () => {
  showError();
  try {
    const state = await window.whale.survivalStatus();
    if (!state.job) throw new Error('没有保存的施工计划。');
    showBlueprint(state.job.plan, true);
  } catch (error) { showError(error.message || String(error)); }
});
startSurvivalButton.addEventListener('click', async event => {
  event.preventDefault(); showError(); startSurvivalButton.disabled = true;
  try {
    const plan = JSON.parse(blueprintJson.value);
    blueprintDialog.close();
    survivalStatusNode.textContent = '正在备份世界并准备施工…';
    if (resuming) await window.whale.resumeSurvivalBuild();
    else await window.whale.startSurvivalBuild(plan);
    await refreshSurvival();
  } catch (error) { showError(error.message || String(error)); }
  finally { startSurvivalButton.disabled = false; }
});
stopSurvivalButton.addEventListener('click', async () => {
  showError(); stopSurvivalButton.disabled = true;
  try { await window.whale.stopSurvivalBuild(); await refreshSurvival(); }
  catch (error) { showError(error.message || String(error)); }
});
refreshSurvival(); setInterval(refreshSurvival, 5000);
modeButtons.forEach((button) => button.addEventListener('click', async () => {
  if (sendButton.disabled) return;
  showError();
  try {
    render(await window.whale.setBuildPlannerMode(button.dataset.mode));
  } catch (error) {
    showError(error.message || String(error));
  }
}));

window.whale.buildPlannerState().then(render).catch((error) => showError(error.message));
input.focus();
