const STEPS = [
  { id: 'model', title: 'AI 模型', eyebrow: '第 1 步，共 7 步' },
  { id: 'game', title: '游戏与整合包', eyebrow: '第 2 步，共 7 步' },
  { id: 'resources', title: '语音功能（可选）', eyebrow: '第 3 步，共 7 步' },
  { id: 'persona', title: '人设与皮肤', eyebrow: '第 4 步，共 7 步' },
  { id: 'network', title: '联机设置', eyebrow: '第 5 步，共 7 步' },
  { id: 'check', title: '准备情况自检', eyebrow: '第 6 步，共 7 步' },
  { id: 'dashboard', title: '伙伴监管中心', eyebrow: '配置完成' }
];

let state = { config: null, step: 0, scan: null, instance: null, wbStatus: null, wbModels: [], selfCheck: null, serverStatus: null, botStatus: null, sakuraStatus: null, apiKeyDraft: '', systemVoices: [], voiceError: '' };
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const friendlyError = (error) => String(error?.message || error || '未知错误')
  .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
  .replace(/^Error:\s*/i, '');

async function refreshSkinAvatar() {
  const canvas = $('#skin-avatar');
  if (!canvas) return;
  const source = await window.whale.readSkin(state.config.persona.skinPath);
  if (!source) return;
  const image = new Image();
  image.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    if (image.naturalWidth >= 64) ctx.drawImage(image, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  };
  image.src = source;
}

function generateRandomSkinDataUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  const palettes = [
    ['#173b5c','#28698a','#6fc6d5','#d9fbff','#f2b36f'],
    ['#2f315b','#565b9b','#9a9ee0','#f0efff','#f0b96e'],
    ['#25483f','#3f7a68','#8ac7a6','#efffe9','#e9a968']
  ];
  const [dark, base, light, pale, accent] = palettes[Math.floor(Math.random() * palettes.length)];
  const fill = (color, rects) => { ctx.fillStyle=color; rects.forEach(([x,y,w,h]) => ctx.fillRect(x,y,w,h)); };
  fill(base, [[8,0,8,8],[16,0,8,8],[0,8,8,8],[8,8,8,8],[16,8,8,8],[24,8,8,8],[20,16,8,4],[28,16,8,4],[16,20,4,12],[20,20,8,12],[28,20,4,12],[32,20,8,12],[44,16,4,4],[48,16,4,4],[40,20,4,12],[44,20,4,12],[48,20,4,12],[52,20,4,12],[36,48,4,4],[40,48,4,4],[32,52,4,12],[36,52,4,12],[40,52,4,12],[44,52,4,12],[4,16,4,4],[8,16,4,4],[0,20,4,12],[4,20,4,12],[8,20,4,12],[12,20,4,12],[20,48,4,4],[24,48,4,4],[16,52,4,12],[20,52,4,12],[24,52,4,12],[28,52,4,12]]);
  fill(light, [[8,8,8,3],[20,20,8,4],[44,20,4,5],[36,52,4,5]]);
  fill(dark, [[9,11,2,2],[13,11,2,2],[10,15,4,1],[20,28,8,4],[4,28,4,4],[20,60,4,4]]);
  fill(pale, [[9,11,1,1],[13,11,1,1],[11,13,2,1]]);
  fill(accent, [[11,15,2,1],[22,22,4,2]]);
  return canvas.toDataURL('image/png');
}

function notify(message, kind = '') {
  const node = $('#notice');
  node.textContent = message;
  node.className = `notice ${kind}`.trim();
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => node.classList.add('hidden'), 5200);
}

function renderSteps() {
  $('#steps').innerHTML = STEPS.map((step, index) => `<button class="step ${index === state.step ? 'active' : ''} ${index < state.config.completedStep ? 'complete' : ''}" data-step="${index}"><span class="step-number">${index < state.config.completedStep ? '✓' : index + 1}</span><span>${step.title}</span></button>`).join('');
  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', async () => {
    if (state.preparing || state.serverStarting || state.serverStatus?.busy) return notify('正在准备资源或保存世界，请等待完成。');
    if (state.navigationBusy) return;
    state.navigationBusy = true;
    try { await save(); state.step = Number(button.dataset.step); render(); }
    catch (error) { notify(friendlyError(error), 'error'); }
    finally { state.navigationBusy = false; }
  }));
}

function channelCard(id, icon, title, text) {
  const selected = state.config.model.channel === id;
  return `<button type="button" class="card selectable choice-card ${selected ? 'selected' : ''}" data-channel="${id}" aria-pressed="${selected}"><span class="icon-box">${icon}</span><span class="choice-copy"><strong>${title}</strong><small>${text}</small></span></button>`;
}

function renderSegmentedChoice({ label, name, value, options }) {
  return `<section class="choice-section" aria-label="${esc(label)}"><div class="choice-heading"><span>${esc(label)}</span><small>选择一项后显示对应配置</small></div><div class="ui-segment" role="group" aria-label="${esc(label)}">${options.map((option) => `<button type="button" data-${name}="${esc(option.id)}" aria-pressed="${option.id === value}"><span class="ui-segment-icon">${esc(option.icon)}</span><span class="ui-segment-copy"><strong>${esc(option.label)}</strong><small>${esc(option.description)}</small></span></button>`).join('')}</div></section>`;
}

function renderEmptyState({ icon, title, description, actionId, actionLabel }) {
  return `<div class="ui-empty"><span class="ui-empty-icon">${esc(icon)}</span><strong>${esc(title)}</strong><small>${esc(description)}</small>${actionId ? `<button type="button" class="button ghost" id="${esc(actionId)}">${esc(actionLabel)}</button>` : ''}</div>`;
}

function renderModel() {
  const m = state.config.model;
  const wbInfo = state.wbStatus
    ? `<span class="badge ${state.wbStatus.signedIn ? 'good' : 'warn'}">${state.wbStatus.signedIn ? `已登录 ${esc(state.wbStatus.nickname || '')}` : (state.wbStatus.available === false ? '通道组件异常' : '尚未登录')}</span>${!state.wbStatus.signedIn && state.wbStatus.reason ? `<small>${esc(state.wbStatus.reason)}</small>` : ''}`
    : '<span class="badge">等待检测</span>';
  let detail = '';
  if (m.channel === 'workbuddy') {
    const modelChooser = state.wbModels.length
      ? `<div class="field"><label>选择模型</label><div class="inline"><select id="wb-model"><option value="">请选择一个模型</option>${state.wbModels.map((x) => `<option value="${esc(x.id)}" ${x.id === m.workbuddyModel ? 'selected' : ''}>${esc(x.name)} · ${esc(x.credits)}</option>`).join('')}</select><button class="button ghost" id="load-models">刷新模型</button></div></div><div class="model-list">${state.wbModels.slice(0, 12).map((x) => `<button type="button" class="model-row ${x.id === m.workbuddyModel ? 'selected' : ''}" data-model="${esc(x.id)}" aria-pressed="${x.id === m.workbuddyModel}"><span><strong>${esc(x.name)}</strong><small>${esc(x.id)} · 上下文 ${Math.round((x.contextWindow || 0)/1000)}K</small></span><span><span class="badge ${x.free ? 'good' : ''}">${esc(x.credits)}</span>${x.supportsImages ? '<span class="badge">视觉</span>' : ''}</span></button>`).join('')}</div>`
      : renderEmptyState({ icon: '◎', title: '还没有获取模型列表', description: '请先登录 WorkBuddy，再检测账号并读取当前可用模型。', actionId: 'load-models', actionLabel: '获取模型' });
    detail = `<div class="card"><div class="inline"><div><h2>WorkBuddy 积分通道</h2><p>使用你自己的 WorkBuddy 账号和积分。配置器不会显示或明文保存登录令牌。</p>${wbInfo}</div><div class="inline"><button class="button ghost" id="open-wb">打开 WorkBuddy 登录</button><button class="button ghost" id="detect-wb">检测账号</button></div></div>${modelChooser}</div>`;
  } else {
    detail = `<div class="card"><h2>连接自己的模型 API</h2><p>适用于 OpenAI 兼容接口。费用由相应模型服务商从你的账户余额扣除。</p><div class="grid"><div class="field"><label>接口地址</label><input id="api-url" value="${esc(m.baseUrl)}" placeholder="https://api.example.com/v1"></div><div class="field"><label>模型名称</label><input id="api-model" value="${esc(m.modelId)}" placeholder="例如 deepseek-flash"></div></div><div class="field"><label>API Key</label><input id="api-key" type="password" value="" placeholder="${m.hasApiKey ? '已安全保存；留空表示不修改' : '输入服务商提供的 API Key'}"><small>使用 Windows 系统加密保存，不写入项目文件。</small></div></div>`;
  }
  const selector = renderSegmentedChoice({ label: '模型使用方式', name: 'channel', value: m.channel, options: [
    { id: 'workbuddy', icon: '积', label: '经济型', description: '使用 WorkBuddy 积分' },
    { id: 'api', icon: 'API', label: '其他模型', description: '使用自己的 API 余额' }
  ] });
  return `<div class="hero"><p>先决定伙伴的大脑来自哪里。后面的所有行为、对话和代码生成都由同一个伙伴完成。</p></div>${selector}<div class="spacer"></div>${detail}`;
}

function renderGame() {
  const g = state.config.game;
  const detected = state.scan?.launchers || [];
  const instances = detected.flatMap((root) => root.versions.map((version) => ({ ...version, root: root.root })));
  let sourcePanel;
  if (g.source === 'pcl2') {
    sourcePanel = `<div class="inline"><div><h2>PCL2 已安装版本</h2><p>只读扫描用户本机已有实例，不下载、更新或改动 PCL2 文件。</p></div><button id="scan-system" class="button ghost">重新扫描</button></div><div class="field"><label>选择已安装版本</label><select id="detected-instance"><option value="">${instances.length ? '请选择一个 PCL2 版本' : '未自动找到，可手动选择目录'}</option>${instances.map((v) => `<option value="${esc(v.path)}" data-version="${esc(v.minecraftVersion)}" data-loader="${esc(v.modLoader)}" data-loader-version="${esc(v.loaderVersion||'')}" data-java-major="${Number(v.javaMajor)||0}" ${v.path === g.instancePath ? 'selected' : ''}>${esc(v.name)} · ${esc(v.minecraftVersion || '版本未知')} · ${esc(v.modLoader)}${v.loaderVersion?` ${esc(v.loaderVersion)}`:''} — ${esc(v.root)}</option>`).join('')}</select><small>游戏版本由用户选择；minebot 自动匹配已有 Java，缺少时会下载到应用数据目录。</small></div><div class="field"><label>手动选择 PCL2 实例目录</label><div class="inline"><input id="instance-path" class="path" value="${esc(g.instancePath)}" placeholder="选择某个 versions 下的版本目录"><button id="choose-instance" class="button ghost">浏览</button></div></div>`;
  } else if (g.source === 'folder') {
    sourcePanel = `<h2>已解压的整合包</h2><p>只读检查原目录，配置时会复制到独立服务器工作目录。</p><div class="field"><label>整合包目录</label><div class="inline"><input id="instance-path" class="path" value="${esc(g.instancePath)}" placeholder="选择包含 mods、config 或 saves 的目录"><button id="choose-instance" class="button ghost">浏览</button></div></div>`;
  } else {
    sourcePanel = `<h2>本地整合包文件</h2><p>选择后立即在minebot私有目录中验证并解压，原 ZIP、MRPACK 或 7Z 不会被修改。</p><div class="field"><label>本地整合包压缩包</label><div class="inline"><input id="archive-path" class="path" value="${esc(g.archivePath)}" readonly placeholder="尚未选择"><button id="choose-archive" class="button ghost">验证并导入</button></div>${g.instancePath?`<small>已验证目录：${esc(g.instancePath)}</small>`:''}</div>`;
  }
  const instanceWorlds = state.instance?.worlds || [];
  const serverPicker = `<div class="field"><label>已有服务器目录（可选）</label><div class="inline"><input id="server-template-path" class="path" value="${esc(state.config.server.templatePath || '')}" placeholder="可留空，minebot 将准备匹配的服务器"><button id="choose-server-template" class="button ghost">浏览</button></div><small>会优先使用版本匹配的已有服务器；未找到时，构建时从官方来源下载对应服务端组件。原整合包不会被修改。</small></div>`;
  const worldPicker = g.instancePath ? `<div class="field"><label>选择要开服的世界存档</label><select id="world-path"><option value="">${instanceWorlds.length ? '请选择世界；原存档不会被修改' : '没有现成世界，将自动创建'}</option>${instanceWorlds.map((world) => `<option value="${esc(world.path)}" ${world.path===g.worldPath?'selected':''}>${esc(world.name)} · ${new Date(world.lastPlayedAt).toLocaleString('zh-CN')}</option>`).join('')}</select><small>构建时会复制到独立服务器目录，不覆盖原存档。</small></div>` : '';
  const selector = renderSegmentedChoice({ label: '游戏来源', name: 'game-source', value: g.source, options: [
    { id: 'pcl2', icon: 'P', label: 'PCL2 版本', description: '读取本机已有实例' },
    { id: 'archive', icon: '⇩', label: '整合包文件', description: 'ZIP、MRPACK 或 7Z' },
    { id: 'folder', icon: '▣', label: '已解压目录', description: '使用现有文件夹' }
  ] });
  return `<div class="hero"><p>可以使用 PCL2 已安装的版本或自己的整合包，服务器在独立目录中配置。启用语音时，会向所选游戏实例添加缺失的兼容语音模组。</p></div>${selector}<div class="spacer"></div><div class="card">${sourcePanel}${worldPicker}${serverPicker}<div class="grid"><div class="field"><label>Minecraft 版本</label><input id="mc-version" value="${esc(g.minecraftVersion)}" placeholder="1.20.1"></div><div class="field"><label>模组加载器</label><select id="loader"><option value="">请选择加载器</option><option value="forge" ${g.modLoader==='forge'?'selected':''}>Forge</option><option value="neoforge" ${g.modLoader==='neoforge'?'selected':''}>NeoForge</option><option value="fabric" ${g.modLoader==='fabric'?'selected':''}>Fabric</option><option value="vanilla" ${g.modLoader==='vanilla'?'selected':''}>原版</option></select></div><div class="field"><label>加载器版本</label><input id="loader-version" value="${esc(g.loaderVersion || '')}" placeholder="自动识别，也可手动输入"></div></div></div>`;
}

function channelCardGame(id, icon, title, text) { const selected=state.config.game.source===id; return `<article class="card selectable ${selected?'selected':''}" data-game-source="${id}"><div class="icon-box">${icon}</div><h2>${title}</h2><p>${text}</p></article>`; }

function toggle(key, title, text) { return `<div class="toggle-row"><div><strong>${title}</strong><small>${text}</small></div><label class="switch"><input type="checkbox" data-toggle="${key}" ${state.config.behavior[key] ? 'checked' : ''}><span class="slider"></span></label></div>`; }

function renderResources() {
  const r = state.config.resources;
  const voices = state.systemVoices.filter((voice) => /^zh(?:-|$)/i.test(voice.culture || ''));
  const voiceOptions = voices.map((voice) => `<option value="${esc(voice.name)}" ${r.ttsVoice === voice.name ? 'selected' : ''}>${esc(voice.label || voice.name)} · ${voice.gender === 'Male' ? '男声' : voice.gender === 'Female' ? '女声' : '声音'}</option>`).join('');
  const voiceSettings = r.voiceEnabled
    ? `<div class="spacer"></div><div class="grid"><div class="card"><h2>自动配置语音模组</h2><div class="check-row"><div><strong>Simple Voice Chat</strong><small>服务端和玩家客户端需使用彼此兼容的版本</small></div><span class="badge good">自动准备</span></div><p>开启语音后，minebot 会匹配版本并添加到当前游戏实例和服务器副本，不覆盖已有文件。游戏正在运行时，请重启游戏。其他玩家也需要兼容的客户端语音模组。</p></div><div class="card"><h2>伙伴声音</h2><p>选择本机 Windows 已安装的中文声音，不需要额外的 AI 语音模型。每台电脑的可用声音可能不同。</p><div class="field"><label for="tts-voice">中文声音</label><select id="tts-voice"><option value="">系统默认声音</option>${r.ttsVoice && !voices.some((v) => v.name === r.ttsVoice) ? `<option value="${esc(r.ttsVoice)}" selected>已选声音不可用：${esc(r.ttsVoice)}</option>` : ''}${voiceOptions}</select><small>${state.voiceError ? esc(state.voiceError) : `找到 ${voices.length} 个中文声音。保存后，重新启动伙伴生效。`}</small></div><div class="inline"><button id="refresh-voices" class="button ghost">刷新声音</button><button id="preview-voice" class="button secondary">试听</button></div><p>语音识别使用 Windows 中文语音识别组件，效果取决于系统支持与麦克风环境。</p></div></div>`
    : `<div class="spacer"></div><div class="card"><span class="badge good">已跳过语音配置</span><h2>仅文字对话</h2><p>配置器不会显示模组要求，不会进行语音检查，也不会生成语音网络配置。</p></div>`;
  const selector = renderSegmentedChoice({ label: '交流方式', name: 'voice-mode', value: r.voiceEnabled ? 'voice' : 'text', options: [
    { id: 'text', icon: '文', label: '仅文字', description: '无需语音模组' },
    { id: 'voice', icon: '语', label: '语音伙伴', description: '配置语音模组与声音' }
  ] });
  return `<div class="hero"><p>语音是可选功能。不需要语音的用户可以直接使用游戏文字聊天与 AI 伙伴交流。</p></div>${selector}${voiceSettings}`;
}

function renderPersonaContent() {
  const p = state.config.persona;
  return `<div class="hero"><p>同一个模型可以拥有完全不同的性格。伙伴头像直接取自当前选择的 Minecraft 皮肤头部。</p></div><div class="grid"><div class="card"><h2>伙伴身份</h2><div class="field"><label>游戏名称</label><input id="persona-name" value="${esc(p.name)}" maxlength="16"></div><div class="field"><label>它是什么样的伙伴？</label><textarea id="persona-description">${esc(p.description)}</textarea></div><div class="field"><label>回复风格</label><input id="reply-style" value="${esc(p.replyStyle)}"></div><label class="toggle-row"><div><strong>主动陪伴</strong><small>身边有玩家时主动问候、提醒和提出小任务</small></div><span class="switch"><input id="proactive" type="checkbox" ${p.proactive?'checked':''}><span class="slider"></span></span></label></div><div class="card"><h2>伙伴外观</h2><div class="skin-heading"><div class="skin-preview"><canvas id="skin-avatar" width="96" height="96"></canvas></div><div><strong>${esc(p.name || '待命名')}</strong><p>头像用于本机预览。可导出给已安装 CustomSkinLoader 的客户端使用；其他玩家需各自在自己的客户端配置。</p><span class="badge ${p.skinMode==='import'?'good':''}">已导入</span><span class="badge ${p.skinMode==='generate'?'good':''}">本地生成</span></div></div><div class="field"><label>皮肤来源</label><select id="skin-mode"><option value="import" ${p.skinMode==='import'?'selected':''}>导入标准 PNG</option><option value="generate" ${p.skinMode==='generate'?'selected':''}>本地随机生成</option></select></div><div class="field"><label>皮肤文件</label><div class="inline"><input id="skin-path" class="path" value="${esc(p.skinPath)}" readonly placeholder="请选择或生成皮肤"><button id="choose-skin" class="button ghost">导入 PNG</button><button id="generate-skin" class="button ghost">随机生成</button><button id="export-local-skin" class="button ghost">导出客户端皮肤</button></div><small>将导出的伙伴名称.png 放入游戏目录 CustomSkinLoader/LocalSkin/skins；请先自行安装兼容的 CustomSkinLoader，再重新进入游戏。不会修改或安装模组。</small></div></div></div><div class="spacer"></div><div class="card"><h2>行为模式</h2><div class="grid">${toggle('selfPreservation','自我保护','血量低时优先保命')}${toggle('unstuck','自动脱困','卡住时尝试恢复移动')}${toggle('selfDefense','受到攻击时反击','不会主动猎杀')}${toggle('itemCollecting','拾取附近物品','自动收集掉落物')}${toggle('torchPlacing','主动补火把','在暗处提供照明')}${toggle('idleStaring','注视附近玩家','增强陪伴感')}</div></div>`;
}

function renderPersona() {
  return `<div class="card"><div class="inline"><div><span class="badge good">独立窗口 · 单 Agent</span><h2>管家模式</h2><p>在独立长对话中选择“全手动”或“管理员”施工路径。前者保留材料收集和搭建过程；后者在备份与授权后走快速生成方案。</p></div><button id="open-build-planner" class="button primary">打开管家模式</button></div></div><div class="spacer"></div>${renderPersonaContent()}`;
}

function renderNetwork() {
  const n = state.config.network;
  const f = state.sakuraStatus;
  const gameTunnel = f?.game;
  const voiceTunnel = f?.voice;
  const sakuraSummary = !f
    ? '<span class="badge">等待检测</span>'
    : !f.installed
      ? '<span class="badge warn">未找到启动器</span>'
      : gameTunnel?.running
        ? `<span class="badge good">日志显示游戏隧道已启动</span><small>TCP：${esc(gameTunnel.address)}${state.config.resources.voiceEnabled ? (voiceTunnel?.running ? ` · UDP：${esc(voiceTunnel.address)}` : ' · 语音隧道未在线') : ''}</small>`
        : `<span class="badge warn">隧道未运行</span><small>${gameTunnel?.address ? `上次游戏地址：${esc(gameTunnel.address)}；该地址现在不标记为可用。` : '请打开 SakuraFrp 并启动游戏 TCP 隧道。'}</small>`;
  const voiceFields = state.config.resources.voiceEnabled ? `<div class="field"><label>语音服务器地址（UDP）</label><input id="voice-address" value="${esc(n.voiceAddress)}" placeholder="域名或 IP:端口"></div>` : '';
  const voicePort = state.config.resources.voiceEnabled ? `<div class="field"><label>本地语音端口</label><input id="voice-port" type="number" value="${n.voiceLocalPort}"></div>` : '';
  const protocolNote = state.config.resources.voiceEnabled ? '<span class="badge">语音 UDP</span> 游戏和语音地址不会混用。' : '<span class="badge good">仅文字模式</span> 不需要配置语音 UDP 地址。';
  const selector = renderSegmentedChoice({ label: '联机方式', name: 'network', value: n.mode, options: [
    { id: 'sakurafrp', icon: '隧', label: 'SakuraFrp', description: state.config.resources.voiceEnabled ? '匹配 TCP 与 UDP' : '自动匹配游戏隧道' },
    { id: 'manual', icon: '✎', label: '手动地址', description: '使用已有公网服务' },
    { id: 'lan', icon: '⌂', label: '仅局域网', description: '本机或同一网络' }
  ] });
  return `<div class="hero"><p>${state.config.resources.voiceEnabled?'游戏连接使用 TCP，语音连接使用独立 UDP 端口。':'当前是仅文字对话模式，只需要配置游戏服务器 TCP 地址。'}</p></div>${selector}<div class="spacer"></div><div class="card"><div class="inline"><div><h2>连接地址</h2><p>${n.mode==='sakurafrp'?'读取本机 SakuraFrp 服务日志，按本地端口匹配隧道日志；日志状态不保证当前连通，需实际测试。':'填写玩家进入游戏所需的地址。'}</p>${n.mode==='sakurafrp'?sakuraSummary:''}</div>${n.mode==='sakurafrp'?'<div class="inline"><button id="open-frp" class="button ghost">打开 SakuraFrp</button><button id="detect-frp" class="button ghost">重新检测</button></div>':''}</div><div class="grid"><div class="field"><label>游戏服务器地址（TCP）</label><input id="game-address" value="${esc(n.gameAddress)}" placeholder="域名或 IP:端口"></div>${voiceFields}</div><div class="grid"><div class="field"><label>本地游戏端口</label><input id="game-port" type="number" value="${n.gameLocalPort}"></div>${voicePort}</div><p><span class="badge">游戏 TCP</span>${protocolNote}</p></div>`;
}

function networkCard(id, icon, title, text) { const selected=state.config.network.mode===id; return `<button type="button" class="card selectable choice-card ${selected?'selected':''}" data-network="${id}" aria-pressed="${selected}"><span class="icon-box">${icon}</span><span class="choice-copy"><strong>${title}</strong><small>${text}</small></span></button>`; }

function checkVisualState(item = {}) {
  if (item.needsChoice || item.status === 'choice') return 'choice';
  if (item.status === 'working') return 'working';
  if (item.status === 'pass' || item.ok && item.status !== 'pending') return 'success';
  if (item.status === 'pending') return item.blocking ? 'repairable' : 'waiting';
  if (item.status === 'error') return item.repairable ? 'repairable' : 'failure';
  return 'waiting';
}

function renderActivityLabel(text, active) {
  return `<span class="activity-label" aria-busy="${Boolean(active)}">${active ? '<span class="ui-activity is-active" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}<span>${esc(text)}</span></span>`;
}

function renderCheckContent() {
  const checks = state.selfCheck?.checks || [];
  const summary = !checks.length ? '点击按钮开始检查。' : state.selfCheck.ready ? (state.selfCheck.pending ? '必要环境已具备；还有项目会在开服阶段自动完成。' : '所有必要检查均已通过。') : `还有 ${state.selfCheck.blockingFailures || 0} 项必须处理。`;
  const labels = { waiting: '等待后续', working: '正在检查', repairable: '可自动准备', choice: '需要选择', success: '已通过', failure: '必须处理' };
  const marks = { waiting: '—', working: '…', repairable: '↻', choice: '?', success: '✓', failure: '!' };
  const timeline = checks.length
    ? `<ol class="ui-timeline">${checks.map((check) => { const visual = checkVisualState(check); return `<li class="ui-timeline-item" data-state="${visual}"><span class="ui-timeline-marker" aria-hidden="true">${marks[visual]}</span><span class="ui-timeline-copy"><strong>${esc(check.title)}</strong><small>${esc(check.detail)}</small></span><span class="ui-status-chip" data-state="${visual}">${labels[visual]}</span></li>`; }).join('')}</ol>`
    : renderEmptyState({ icon: '✓', title: '还没有检查结果', description: '点击“立即自检”，Minebot 会检查模型、游戏、运行环境与联机设置。' });
  return `<div class="hero"><p>自检会区分必须修复、等待配置和可选功能。只有真正阻止启动的项目才会标红。</p></div><div class="grid"><div class="card"><div class="inline"><div><h2>准备情况</h2><p>${summary}</p></div><button id="run-check" class="button ghost">立即自检</button></div>${timeline}</div><div class="card"><h2>即将构建的内容</h2><div class="check-row"><div><strong>唯一 AI 伙伴</strong><small>${esc(state.config.persona.name)} · ${state.config.model.channel==='workbuddy'?'WorkBuddy 积分':'自备 API'}</small></div><span class="badge good">1 个 Agent</span></div><div class="check-row"><div><strong>用户整合包</strong><small>${esc(state.config.game.minecraftVersion)} · ${esc(state.config.game.modLoader)}</small></div><span class="check-mark">✓</span></div><div class="check-row"><div><strong>语音</strong><small>${state.config.resources.voiceEnabled?'启用双向语音':'未启用'}</small></div><span class="check-mark">${state.config.resources.voiceEnabled?'✓':'—'}</span></div><div class="check-row"><div><strong>联机方式</strong><small>${esc(state.config.network.mode)}</small></div><span class="check-mark">→</span></div><p>构建前会显示原包位置、独立服务器目录、复制计划、备份位置和端口配置；开启语音时，会自动准备匹配的必要模组。</p></div></div>`;
}

function renderDashboardContent() {
  const c = state.config;
  const s = state.serverStatus || { phase:'idle', running:false, ready:false, message:'尚未启动' };
  const b = state.botStatus || { phase:'idle', running:false, ready:false, message:'伙伴尚未启动' };
  const f = state.sakuraStatus;
  const publicGame = c.network.mode === 'sakurafrp' && f?.game?.running ? f.game.address : (c.network.mode === 'manual' ? c.network.gameAddress : '');
  const publicVoice = c.resources.voiceEnabled && c.network.mode === 'sakurafrp' && f?.voice?.running ? f.voice.address : (c.network.mode === 'manual' ? c.network.voiceAddress : '');
  const localAddress = s.ready ? `127.0.0.1:${c.network.gameLocalPort}` : '';
  const address = s.ready ? (publicGame || localAddress) : '等待游戏服务器就绪';
  const serverBadge = s.ready ? ['good','运行中'] : s.phase==='starting'||s.phase==='building' ? ['warn','启动中'] : s.phase==='failed' ? ['warn','启动失败'] : ['','未启动'];
  const botBadge = b.ready ? ['good','已进服'] : b.phase==='starting' ? ['warn','连接中'] : b.phase==='failed' ? ['warn','启动失败'] : b.running ? ['warn','运行中'] : ['','未启动'];
  const actionLabel = s.busy ? '正在准备或保存…' : s.running ? (s.phase==='stopping'?'正在停止…':'停止服务器') : s.phase==='failed' ? '自动检查并重试启动' : '准备并启动服务器';
  const botActionLabel = b.running ? (b.phase==='stopping'?'正在退出…':'让伙伴退出') : '启动伙伴';
  const botDisabled = b.phase==='starting'||b.phase==='stopping'||(!s.ready&&!b.running);
  const connectionBadge = c.network.mode === 'sakurafrp' ? (f?.game?.running ? ['good','日志显示隧道已启动'] : ['warn','公网未连接']) : c.network.mode === 'lan' ? ['', '仅本机/局域网'] : (c.network.gameAddress ? ['good','手动地址'] : ['warn','待配置']);
  const connectionText = c.network.mode === 'sakurafrp' ? (f?.game?.running ? `游戏 TCP：${f.game.address}${c.resources.voiceEnabled ? (f.voice?.running ? `；语音 UDP：${f.voice.address}` : '；语音 UDP 未在线') : ''}` : (f?.installed ? 'SakuraFrp 已安装，但游戏 TCP 隧道当前未运行。' : '未找到 SakuraFrp 启动器。')) : c.network.mode === 'lan' ? '仅供本机或同一局域网内的玩家连接。' : (c.network.gameAddress || '请填写现有公网地址。');
  const addressHint = !s.ready ? '游戏服务器尚未就绪；隧道地址不代表已经开服' : publicGame ? '外网玩家在 Minecraft → 多人游戏中输入' : '本机测试在 Minecraft → 多人游戏中输入';
  return `<div class="summary-address"><small>${addressHint}</small><strong>${esc(address)}</strong>${publicGame && localAddress?`<small>本机测试地址：${esc(localAddress)}</small>`:''}${publicVoice?`<small>语音 UDP 地址（不用填入多人游戏）：${esc(publicVoice)}</small>`:''}</div><div class="spacer"></div><div class="grid three"><div class="card"><span class="badge ${serverBadge[0]}">${serverBadge[1]}</span><h2>游戏服务器</h2><p>${esc(s.message || `端口 ${c.network.gameLocalPort}`)}</p>${s.serverDirectory?`<small>服务器副本：${esc(s.serverDirectory)}</small>`:''}${s.mirrorPath?`<small>当日单人存档：${esc(s.mirrorPath)}</small>`:''}<div class="inline"><button id="server-action" class="button primary" ${s.phase==='building'||s.phase==='stopping'||s.phase==='syncing'?'disabled':''}>${actionLabel}</button>${s.logPath?'<button id="open-server-log" class="button ghost">打开日志</button>':''}</div></div><div class="card"><span class="badge ${botBadge[0]}">${botBadge[1]}</span><h2>AI 伙伴 ${esc(c.persona.name)}</h2><p>${esc(b.message || '伙伴尚未启动')}</p><small>${c.model.channel==='workbuddy'?'WorkBuddy 积分通道':'自备 API 通道'} · ${esc(c.model.workbuddyModel || c.model.modelId || '未选模型')}</small><div class="inline"><button id="bot-action" class="button secondary" ${botDisabled?'disabled':''}>${botActionLabel}</button>${b.logPath?'<button id="open-bot-log" class="button ghost">打开日志</button>':''}</div></div><div class="card"><span class="badge ${connectionBadge[0]}">${connectionBadge[1]}</span><h2>联机连接</h2><p>${esc(connectionText)}</p>${c.network.mode==='sakurafrp'?'<div class="inline"><button id="open-frp" class="button secondary">打开 SakuraFrp</button><button id="detect-frp" class="button ghost">刷新状态</button></div>':''}</div></div><div class="spacer"></div><div class="card"><h2>模式监管</h2><p>保存设置并重新启动伙伴后，行为开关才会生效。</p><div class="grid">${toggle('selfPreservation','自我保护','低血量时优先撤离')}${toggle('unstuck','自动脱困','发现卡住后自动恢复')}${toggle('selfDefense','自卫反击','受到攻击时反击')}${toggle('itemCollecting','物品拾取','收集附近掉落物')}${toggle('torchPlacing','自动照明','黑暗区域补充火把')}${toggle('idleStaring','陪伴注视','空闲时看向附近玩家')}</div></div>`;
}

function renderServerProgress() {
  const s = state.serverStatus || {};
  const history = (s.history || []).slice(-8);
  const active = Boolean(state.preparing || s.busy || ['building', 'starting', 'stopping', 'syncing'].includes(s.phase));
  const progress = history.length ? `<ol class="server-progress">${history.map(item => `<li>${esc(item.message)}</li>`).join('')}</ol>` : '<p>启动时会自动准备运行环境、检查世界与模组，再启动游戏服务器和伙伴。</p>';
  const backup = s.recovery?.backupPath ? `<p>${s.recovery.needsChoice ? '原世界和备份已保留，校验未通过。请先查看备份，再选择其他完好的世界；不会自动回退进度。' : '本次世界已自动备份并校验。未写入磁盘的进度不能保证恢复。'}</p><button id="open-recovery-backup" class="button ghost">打开恢复备份</button>` : '';
  const sync = s.syncFailed ? '<p>服务器世界仍保留在工作目录，单人存档尚未同步成功。</p><button id="retry-world-sync" class="button secondary">重新同步单人存档</button>' : '';
  const mods = (s.modPreparation?.installed || []).map(item => `<li>${esc(item.id)} · ${esc(item.version)}</li>`).join('');
  const choice = ['MOD_CHOICE_REQUIRED', 'MOD_FILE_REQUIRED'].includes(s.errorCode) ? `<div class="notice"><h3>需要选择兼容的模组</h3><p class="error-details">${esc(s.message)}</p><p>移除内容模组可能让世界里的方块或物品消失。原世界不会被改写；请先核对上面的冲突，在原整合包中选择兼容版本，然后点击重新检查并启动。</p><button id="open-source-mods" class="button secondary">打开原整合包模组目录</button></div>` : '';
  const worldChoice = s.errorCode === 'WORLD_CHOICE_REQUIRED' ? '<button id="choose-another-world" class="button secondary">重新选择世界存档</button>' : '';
  return `<div class="spacer"></div><div class="card ui-activity-edge" aria-busy="${active}"><div class="section-heading"><div><h2>准备进度与恢复</h2>${active ? renderActivityLabel('正在准备运行资源，请保持 Minebot 打开', true) : '<small>当前没有运行中的准备任务</small>'}</div><span class="ui-status-chip" data-state="${active ? 'working' : s.phase === 'failed' ? 'failure' : s.ready ? 'success' : 'waiting'}">${active ? '处理中' : s.phase === 'failed' ? '需要处理' : s.ready ? '已就绪' : '等待启动'}</span></div>${state.statusError ? `<p class="notice error">${esc(state.statusError)}</p>` : ''}${progress}${choice}${backup}${worldChoice}${sync}${mods ? `<p>已自动补齐依赖：</p><ul>${mods}</ul>` : ''}<p>不会自动移除可能改变世界内容的模组。无法安全处理时会保留世界和诊断文件，供选择后重试。</p></div>`;
}
function renderDashboard() { return renderDashboardContent().replace('<div class="card"><h2>模式监管', `${renderServerProgress()}<div class="card"><h2>模式监管`); }
function renderCheck() {
  return renderCheckContent() + `<div class="spacer"></div><div class="card"><h2>自动准备与修复</h2><p>下载缺少的 Java、服务端和加载器依赖，并校验缓存。准备完成后可以重新自检；世界的备份恢复在开服时处理。</p><button id="prepare-environment" class="button primary" ${state.preparing?'disabled':''}>${state.preparing?'正在准备资源…':'检查并自动准备资源'}</button>${renderServerProgress()}</div>`;
}

function renderAdministrators() {
  const admins = state.config.server.administrators || [];
  const rows = admins.length ? admins.map((name) => `<div class="check-row"><div><strong>${esc(name)}</strong><small>已保存到minebot管理员名单</small></div><button class="button secondary" data-remove-admin="${esc(name)}">移除权限</button></div>`).join('') : '<p>还没有设置管理员。输入你在游戏中使用的玩家 ID。</p>';
  return `<div class="spacer"></div><div class="card"><h2>服务器管理员</h2><p>管理员可以使用传送、游戏模式等服务器指令。运行中的服务器会立即应用；未开服时会保存到下次启动。</p><p>离线身份验证模式下，玩家名称不等于身份验证。请只授权信任的玩家，并保护公网服务器。</p><div class="field"><label for="admin-player-id">玩家 ID</label><div class="inline"><input id="admin-player-id" maxlength="16" autocomplete="off" placeholder="输入玩家的游戏 ID"><button id="add-admin" class="button primary">设置管理员</button></div><small>1–16 位英文字母、数字或下划线，大小写请与游戏中一致。运行中请先让该玩家进入一次服务器。</small></div><div class="model-list">${rows}</div></div>`;
}

function collect() {
  const q = (id) => document.getElementById(id);
  const c = state.config;
  if (state.step === 0) {
    if (q('wb-model')) c.model.workbuddyModel = q('wb-model').value;
    if (q('api-url')) c.model.baseUrl = q('api-url').value.trim();
    if (q('api-model')) c.model.modelId = q('api-model').value.trim();
    if (q('api-key')) state.apiKeyDraft = q('api-key').value;
  }
  if (state.step === 1) {
    if (q('server-template-path')) c.server.templatePath = q('server-template-path').value.trim();
    if (q('instance-path')) c.game.instancePath = q('instance-path').value.trim();
    if (q('archive-path')) c.game.archivePath = q('archive-path').value.trim();
    if (q('mc-version')) c.game.minecraftVersion = q('mc-version').value.trim();
    if (q('loader')) c.game.modLoader = q('loader').value;
    if (q('loader-version')) c.game.loaderVersion = q('loader-version').value.trim();
    if (q('world-path')) c.game.worldPath = q('world-path').value;
  }
  if (state.step === 2) {
    if (q('tts-voice')) c.resources.ttsVoice = q('tts-voice').value;
    if (q('stt-model')) c.resources.sttModel = q('stt-model').value;
  }
  if (state.step === 3) {
    c.persona.name = q('persona-name').value.trim(); c.persona.description = q('persona-description').value.trim(); c.persona.replyStyle = q('reply-style').value.trim(); c.persona.proactive = q('proactive').checked; c.persona.skinMode = q('skin-mode').value;
  }
  if (state.step === 4) {
    c.network.gameAddress = q('game-address').value.trim(); if (q('voice-address')) c.network.voiceAddress = q('voice-address').value.trim(); c.network.gameLocalPort = Number(q('game-port').value) || 25565; if (q('voice-port')) c.network.voiceLocalPort = Number(q('voice-port').value) || 24454;
  }
  document.querySelectorAll('[data-toggle]').forEach((node) => { c.behavior[node.dataset.toggle] = node.checked; });
}

function applyInstance(directory, inspected, archivePath = '') {
  state.config.game = { ...state.config.game, instancePath: directory, archivePath, worldPath: '', minecraftVersion: inspected?.minecraftVersion || '', modLoader: inspected?.modLoader || '', loaderVersion: inspected?.loaderVersion || '', javaMajor: Number(inspected?.javaMajor) || 0 };
  state.config.server.templatePath = '';
  state.instance = inspected;
  state.selfCheck = null;
}

function bind() {
  // Capture edits before asynchronous refreshes replace the form DOM.
  for (const event of ['input', 'change']) $('#content').addEventListener(event, collect, { capture: true });
  document.querySelectorAll('[data-channel]').forEach((x) => x.onclick = () => { collect(); state.config.model.channel=x.dataset.channel; render(); });
  document.querySelectorAll('[data-game-source]').forEach((x) => x.onclick = () => { collect(); state.config.game.source=x.dataset.gameSource; render(); });
  document.querySelectorAll('[data-network]').forEach((x) => x.onclick = () => { collect(); state.config.network.mode=x.dataset.network; render(); });
  document.querySelectorAll('[data-voice-mode]').forEach((x) => x.onclick = () => { collect(); state.config.resources.voiceEnabled=x.dataset.voiceMode==='voice'; render(); });
  document.querySelectorAll('[data-model]').forEach((x) => x.onclick = () => { state.config.model.workbuddyModel=x.dataset.model; render(); });
  $('#detect-wb')?.addEventListener('click', async () => { state.wbStatus=await window.whale.workbuddyStatus(); notify(state.wbStatus.signedIn?'已找到 WorkBuddy 登录账号。':state.wbStatus.reason||'未找到登录账号', state.wbStatus.signedIn?'success':'error'); render(); });
  $('#refresh-voices')?.addEventListener('click', async () => { collect(); await refreshSystemVoices(); render(); });
  $('#preview-voice')?.addEventListener('click', async () => { try { const name=$('#tts-voice').value; notify('正在生成试听…'); const url=await window.whale.previewSystemVoice(name); await new Audio(url).play(); } catch(error) { notify(friendlyError(error),'error'); } });
  $('#open-wb')?.addEventListener('click', async () => { const result=await window.whale.openWorkBuddy(); notify(result.message,result.ok?'success':'error'); });
  $('#load-models')?.addEventListener('click', async () => { notify('正在读取当前账号可用模型…'); try { state.wbModels=await window.whale.workbuddyModels(); notify(`已获取 ${state.wbModels.length} 个模型。`,'success'); render(); } catch(e) { notify(`模型读取失败：${friendlyError(e)}`,'error'); } });
  $('#wb-model')?.addEventListener('change', (e) => { state.config.model.workbuddyModel=e.target.value; });
  $('#scan-system')?.addEventListener('click', async () => { state.scan=await window.whale.scanSystem(); notify('扫描完成。','success'); render(); });
  $('#detected-instance')?.addEventListener('change', async (e) => {
    try { const inspected=e.target.value?await window.whale.inspectInstance(e.target.value):null; applyInstance(e.target.value, inspected); render(); }
    catch(error) { notify(friendlyError(error),'error'); }
  });
  $('#mc-version')?.addEventListener('change', () => { state.config.game.javaMajor=0; state.config.game.loaderVersion=''; if($('#loader-version')) $('#loader-version').value=''; state.selfCheck=null; });
  $('#loader')?.addEventListener('change', () => { state.config.game.loaderVersion=''; if($('#loader-version')) $('#loader-version').value=''; state.selfCheck=null; });
  $('#choose-server-template')?.addEventListener('click', async () => {
    collect();
    const selected = await window.whale.chooseDirectory('选择与游戏版本和加载器匹配的已有服务器目录');
    if (!selected) return;
    state.config.server.templatePath = selected;
    render();
  });
  $('#choose-instance')?.addEventListener('click', async () => {
    const p=await window.whale.chooseDirectory(state.config.game.source==='pcl2'?'选择 PCL2 已安装版本目录':'选择已解压整合包目录');
    if(!p) return;
    try { const inspected=await window.whale.inspectInstance(p); applyInstance(p, inspected); render(); }
    catch(error) { notify(friendlyError(error),'error'); }
  });
  $('#choose-archive')?.addEventListener('click', async () => {
    const p=await window.whale.chooseArchive();
    if(!p) return;
    notify('正在验证压缩包路径并导入，请稍候…');
    try {
      const result=await window.whale.prepareArchive(p);
      applyInstance(result.root, result.inspection, p);
      notify(result.reused?'已复用上次验证的本地副本。':'整合包已安全导入，请选择世界存档。','success');
      render();
    } catch(e) { notify(friendlyError(e),'error'); }
  });
  $('#choose-skin')?.addEventListener('click', async () => { const p=await window.whale.chooseSkin(); if(p){state.config.persona.skinPath=p; state.config.persona.skinMode='import'; render();} });
  $('#export-local-skin')?.addEventListener('click', async () => {
    try {
      collect();
      const result = await window.whale.exportLocalSkin(state.config.persona.skinPath, state.config.persona.name);
      if (!result.canceled) notify('皮肤已导出。请放入客户端 CustomSkinLoader 的 LocalSkin/skins 文件夹，重新进入游戏查看。', 'success');
    } catch (error) { notify(friendlyError(error), 'error'); }
  });
  $('#generate-skin')?.addEventListener('click', async () => { const p=await window.whale.saveGeneratedSkin(generateRandomSkinDataUrl()); state.config.persona.skinPath=p; state.config.persona.skinMode='generate'; notify('已在本机生成新的伙伴皮肤。','success'); render(); });
  $('#open-build-planner')?.addEventListener('click', async () => { await window.whale.openBuildPlanner(); });
  $('#run-check')?.addEventListener('click', async () => { try { collect(); notify('正在检查模型、游戏、语音和网络…'); state.selfCheck=await window.whale.runSelfCheck(state.config); notify(state.selfCheck.ready?(state.selfCheck.pending?'必要环境已具备，部分项目等待后续配置。':'所有必要检查均已通过。'):`检查完成，还有 ${state.selfCheck.blockingFailures} 项必须处理。`,state.selfCheck.ready?'success':'error'); render(); } catch(error) { notify(friendlyError(error),'error'); } });
  $('#prepare-environment')?.addEventListener('click', async () => {
    if (state.preparing) return;
    try { await save(); state.preparing=true; render(); state.serverStatus=await window.whale.prepareServer(state.config); if(state.serverStatus.resolvedGame) { state.config.game={...state.serverStatus.resolvedGame}; render(); await save(); } state.selfCheck=await window.whale.runSelfCheck(state.config); notify('运行资源准备完成。','success'); }
    catch(error) { notify(friendlyError(error),'error'); }
    finally { state.preparing=false; state.serverStatus=await window.whale.serverStatus(); render(); }
  });
  $('#retry-world-sync')?.addEventListener('click', async () => { try { state.serverStatus=await window.whale.retryWorldSync(); notify('单人存档同步完成。','success'); } catch(error) { notify(friendlyError(error),'error'); } finally { render(); } });
  $('#open-recovery-backup')?.addEventListener('click', () => window.whale.openPath(state.serverStatus?.recovery?.backupPath));
  $('#open-source-mods')?.addEventListener('click', () => window.whale.openPath(`${state.config.game.instancePath}\\mods`));
  $('#choose-another-world')?.addEventListener('click', () => { state.step = 1; render(); });
  $('#detect-frp')?.addEventListener('click', async () => {
    collect();
    state.sakuraStatus=await window.whale.sakuraStatus(state.config.network);
    if(state.sakuraStatus.game?.running) state.config.network.gameAddress=state.sakuraStatus.game.address;
    if(state.sakuraStatus.voice?.running) state.config.network.voiceAddress=state.sakuraStatus.voice.address;
    const message=state.sakuraStatus.game?.running
      ? `已获取游戏公网地址 ${state.sakuraStatus.game.address}${state.sakuraStatus.voice?.running ? `，语音地址 ${state.sakuraStatus.voice.address}` : ''}`
      : state.sakuraStatus.message;
    notify(message,state.sakuraStatus.game?.running?'success':'');
    render();
  });
  $('#open-frp')?.addEventListener('click', async () => { const result=await window.whale.openSakura(); notify(result.message,result.ok?'success':'error'); });
  $('#server-action')?.addEventListener('click', async () => {
    if(state.serverStatus?.busy || state.serverStarting) return;
    state.serverStarting = true;
    try {
      if(state.serverStatus?.running) {
        state.serverStatus=await window.whale.stopServer();
        notify('正在保存世界并停止服务器…');
      } else {
        await save();
        state.selfCheck=await window.whale.runSelfCheck(state.config);
        if(!state.selfCheck.ready) {
          state.step=5;
          notify(`已拦截启动：还有 ${state.selfCheck.blockingFailures} 项必须处理。`,'error');
          render();
          return;
        }
        notify('正在创建独立服务器副本，请不要关闭应用…');
        state.serverStatus=await window.whale.buildAndStartServer(state.config);
      }
      render();
    } catch(e) { state.serverStatus=await window.whale.serverStatus(); notify(friendlyError(e),'error'); render(); }
    finally { state.serverStarting = false; render(); }
  });
  $('#open-server-log')?.addEventListener('click', () => window.whale.openPath(state.serverStatus?.logPath));
  $('#add-admin')?.addEventListener('click', async () => {
    const input = $('#admin-player-id');
    const name = input.value.trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return notify('请输入 1–16 位英文字母、数字或下划线组成的玩家 ID。', 'error');
    if ((state.config.server.administrators || []).some((entry) => entry.toLowerCase() === name.toLowerCase())) return notify('该玩家已在管理员名单中。');
    try {
      state.adminBusy = true;
      input.disabled = true; $('#add-admin').disabled = true;
      const result = await window.whale.setAdministrator(name, true);
      state.config.server.administrators = result.administrators;
      state.config.server.revokedAdministrators = result.revokedAdministrators;
      notify(result.applied ? `已确认 ${name} 获得管理员权限。` : `已保存 ${name}，下次启动服务器时应用。`, 'success');
      render();
    } catch (error) { input.disabled = false; $('#add-admin').disabled = false; notify(friendlyError(error), 'error'); } finally { state.adminBusy = false; }
  });
  document.querySelectorAll('[data-remove-admin]').forEach((button) => button.addEventListener('click', async () => {
    const name = button.dataset.removeAdmin;
    try {
      state.adminBusy = true;
      button.disabled = true;
      const result = await window.whale.setAdministrator(name, false);
      state.config.server.administrators = result.administrators;
      state.config.server.revokedAdministrators = result.revokedAdministrators;
      notify(result.applied ? `已确认 ${name} 的管理员权限已移除。` : `已从下次开服名单移除 ${name}。`, 'success');
      render();
    } catch (error) { button.disabled = false; notify(friendlyError(error), 'error'); } finally { state.adminBusy = false; }
  }));
  $('#open-bot-log')?.addEventListener('click', () => window.whale.openPath(state.botStatus?.logPath));
  $('#bot-action')?.addEventListener('click', async () => {
    try {
      if(state.botStatus?.running) {
        state.botStatus=await window.whale.stopBot();
        notify('正在让 AI 伙伴安全退出…');
      } else {
        await save();
        state.botStatus=await window.whale.startBot(state.config);
        notify('正在连接唯一的 AI 伙伴…');
      }
      render();
    } catch(e) { notify(friendlyError(e),'error'); }
  });
}

async function save() {
  collect();
  state.config.completedStep = Math.max(state.config.completedStep, Math.min(state.step + 1, 6));
  const key = state.apiKeyDraft || undefined;
  state.config = await window.whale.saveConfig(state.config, key);
  state.apiKeyDraft = '';
  $('#save-state').textContent = '已保存到本机';
  setTimeout(() => $('#save-state').textContent='切换步骤时保存配置', 1800);
}

async function refreshSystemVoices() {
  try { state.systemVoices=await window.whale.listSystemVoices(); state.voiceError=''; }
  catch(error) { state.systemVoices=[]; state.voiceError=friendlyError(error); }
}

function render() {
  const step = STEPS[state.step];
  $('#eyebrow').textContent=step.eyebrow; $('#page-title').textContent=step.title;
  $('#content').innerHTML=[renderModel,renderGame,renderResources,renderPersona,renderNetwork,renderCheck,renderDashboard][state.step]();
  if ($('#server-action')) $('#server-action').disabled=Boolean(state.serverStatus?.busy || state.serverStarting || ['stopping','syncing'].includes(state.serverStatus?.phase));
  if (state.step === 6) $('#content').insertAdjacentHTML('beforeend', renderAdministrators());
  refreshSkinAvatar().catch(() => {});
  const navigationBlocked=Boolean(state.preparing || state.serverStarting || state.serverStatus?.busy);
  $('#back').disabled=state.step===0 || navigationBlocked; $('#next').disabled=navigationBlocked; $('#next').textContent=state.step>=5?(state.step===6?'保存设置':'进入监管界面'):'保存并继续';
  const serverPill=$('#server-pill');
  if(state.step===6){
    const publicAddress=state.config.network.mode==='sakurafrp'&&state.sakuraStatus?.game?.running?state.sakuraStatus.game.address:(state.config.network.mode==='manual'?state.config.network.gameAddress:'');
    const localAddress=state.serverStatus?.ready?`127.0.0.1:${state.config.network.gameLocalPort}`:'';
    serverPill.classList.remove('hidden');
    $('#server-address').textContent=state.serverStatus?.ready?(publicAddress||localAddress):'等待服务器就绪';
  }else serverPill.classList.add('hidden');
  renderSteps(); bind();
}

async function navigate(direction) {
  if(state.navigationBusy || state.preparing || state.serverStarting || state.serverStatus?.busy) return;
  state.navigationBusy=true;
  try {
    await save();
    if(direction>0 && state.step===5) {
      state.selfCheck=await window.whale.runSelfCheck(state.config);
      if(!state.selfCheck.ready) { notify(`还有 ${state.selfCheck.blockingFailures} 项必须处理，全部通过后才能进入监管界面。`,'error'); render(); return; }
    }
    state.step=Math.max(0,Math.min(6,state.step+direction)); render();
  } catch(error) { notify(friendlyError(error),'error'); }
  finally { state.navigationBusy=false; }
}
$('#back').addEventListener('click', () => navigate(-1));
$('#next').addEventListener('click', () => navigate(1));

async function refreshRuntimeStatus() {
  if(state.statusRefreshing) return;
  state.statusRefreshing=true;
  try {
    const results=await Promise.allSettled([window.whale.serverStatus(),window.whale.botStatus(),window.whale.sakuraStatus(state.config.network)]);
    state.statusError='';
    const keys=['serverStatus','botStatus','sakuraStatus'];
    results.forEach((result,index) => {
      if(result.status==='fulfilled') state[keys[index]]=result.value;
      else {
        state.statusError='暂时无法刷新部分运行状态，正在自动重试。请勿据旧状态重复启动。';
        if(index===0) state.serverStatus={...state.serverStatus,ready:false,busy:true,message:'服务器状态暂时不可读取，等待刷新…'};
        if(index===1) state.botStatus={...state.botStatus,ready:false,message:'伙伴状态暂时不可读取，等待刷新…'};
        if(index===2) state.sakuraStatus={game:{running:false},voice:{running:false}};
      }
    });
    if(state.sakuraStatus?.game?.running) state.config.network.gameAddress=state.sakuraStatus.game.address;
    if(state.sakuraStatus?.voice?.running) state.config.network.voiceAddress=state.sakuraStatus.voice.address;
    if(document.activeElement?.id!=='admin-player-id' && !state.adminBusy) render();
  } finally { state.statusRefreshing=false; }
}

(async () => {
  const initial=await window.whale.getState();
  state.config=initial.config;
  $('#app-version').textContent=initial.version ? `版本 ${initial.version}` : '版本信息暂不可用';
  render();
  await refreshSystemVoices();
  if(initial.recoveryNotice) notify(initial.recoveryNotice,'error');
  const initialResults=await Promise.allSettled([window.whale.scanSystem(),window.whale.workbuddyStatus(),state.config.game.instancePath?window.whale.inspectInstance(state.config.game.instancePath):Promise.resolve(null)]);
  const fallback=[{javaCandidates:[],instances:[]},{signedIn:false,reason:'账号状态暂时无法读取，请点击检测账号重试。'},null];
  ['scan','wbStatus','instance'].forEach((key,index)=>{state[key]=initialResults[index].status==='fulfilled'?initialResults[index].value:fallback[index];});
  await refreshRuntimeStatus();
  setInterval(() => {
    if(state.step!==6 && !(state.step===5 && state.preparing) && !state.statusError) return;
    refreshRuntimeStatus().catch(error=>{state.statusError=friendlyError(error);});
  },2000);
})().catch((error) => { $('#content').innerHTML=`<div class="card"><h2>配置器启动失败</h2><p>${esc(friendlyError(error))}</p><p>请重新打开minebot；如果仍然失败，请保留 profile 目录中的配置与日志。</p></div>`; });
