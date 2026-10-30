const messagesNode = document.getElementById('messages');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const clearButton = document.getElementById('clear');
const statusNode = document.getElementById('status');
const errorNode = document.getElementById('error');
const modeNote = document.getElementById('mode-note');
const executeButton = document.getElementById('execute');
const modeButtons = [...document.querySelectorAll('[data-mode]')];

const MODE_COPY = {
  manual: '当前为生存建造规划：伙伴整理材料、采集和施工方案；自动执行完整流程尚未实现。',
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

