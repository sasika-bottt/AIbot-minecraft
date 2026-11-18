const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { DEFAULT_CONFIG } = require('../src/services/config-store.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-ui-smoke-'));
app.disableHardwareAcceleration();
app.setPath('userData', scratch);

function assertLight(color, message) {
  const channels = String(color).match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
  assert.equal(channels.length, 3, `${message}：无法读取颜色 ${color}`);
  assert.ok(channels.every(channel => channel >= 230), `${message}：实际为 ${color}`);
}

function assertDark(color, message) {
  const channels = String(color).match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
  assert.equal(channels.length, 3, `${message}：无法读取颜色 ${color}`);
  assert.ok(channels.every(channel => channel <= 105), `${message}：实际为 ${color}`);
}

function assertSharedUiSources() {
  const sharedCss = path.join(__dirname, '../src/renderer/ui-primitives.css');
  const provenance = path.join(__dirname, '../docs/THIRD_PARTY_UI.md');
  const mainHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const butlerHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/build-chat.html'), 'utf8');
  assert.equal(fs.existsSync(sharedCss), true, '主窗口与管家窗口需要共享原生组件样式层');
  assert.match(mainHtml, /href="ui-primitives\.css"/, '主窗口必须加载共享组件样式');
  assert.match(butlerHtml, /href="ui-primitives\.css"/, '管家窗口必须加载共享组件样式');
  const css = fs.readFileSync(sharedCss, 'utf8');
  assert.doesNotMatch(css, /https?:\/\//i, '共享组件样式不能依赖远程资源');
  assert.doesNotMatch(css, /tailwind|react(?:-dom)?/i, '共享组件层不能引入 React 或 Tailwind 运行时');
  assert.equal(fs.existsSync(provenance), true, '必须记录免费组件来源与许可证边界');
  const record = fs.readFileSync(provenance, 'utf8');
  for (const source of ['BoardUI', 'Libraries.dev', 'Watermelon UI', 'Bencho', 'HeroUI Pro']) {
    assert.match(record, new RegExp(source.replace('.', '\\.')), `来源记录必须说明 ${source}`);
  }
  assert.doesNotMatch(record, /\bbeUI\b/i, '来源记录不能声明无法验证的 beUI 仓库或许可证');
  assert.match(record, /MIT/, '来源记录必须标明采用的开源许可证');
  assert.match(record, /不使用|未使用/, '来源记录必须明确排除付费 Pro 内容');
}

function installMainFixtures() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.persona.name = '示例伙伴';
  config.network.gameAddress = 'example.invalid:25565';
  const handlers = {
    'app:get-state': () => ({ config, version: require('../package.json').version }),
    'app:save-config': (_, value) => value.config,
    'system:scan': () => ({ java: [], instances: [] }),
    'voice:list': () => [],
    'workbuddy:status': () => ({ connected: false }),
    'server:status': () => ({ phase: 'idle', ready: false, message: '等待准备' }),
    'bot:status': () => ({ phase: 'idle', ready: false }),
    'network:sakura-status': () => ({ installed: false, game: {}, voice: {} }),
    'app:self-check': () => ({ ready: true, pending: false, blockingFailures: 0, items: [] }),
    'skin:read': () => '',
    'shell:open-path': () => ''
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
}

async function inspectMainWindow() {
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '../src/preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await new Promise(resolve => setTimeout(resolve, 350));
  await win.webContents.executeJavaScript("state.wbModels=[{id:'demo-model',name:'示例模型',credits:'1 积分',contextWindow:32000}];render()");
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  });
  const componentHierarchy = await win.webContents.executeJavaScript(`(() => {
    const inspect = (step, selector) => {
      state.step = step;
      render();
      const buttons = [...document.querySelectorAll(selector)];
      return {
        hasSegment: Boolean(document.querySelector('.ui-segment')),
        count: buttons.length,
        semantic: buttons.every(node => node.tagName === 'BUTTON' && node.hasAttribute('aria-pressed')),
        selected: buttons.filter(node => node.getAttribute('aria-pressed') === 'true').length
      };
    };
    state.wbModels = [];
    const model = inspect(0, '[data-channel]');
    const emptyState = {
      visible: Boolean(document.querySelector('.ui-empty')),
      open: Boolean(document.getElementById('open-wb')),
      detect: Boolean(document.getElementById('detect-wb')),
      load: Boolean(document.getElementById('load-models'))
    };
    const game = inspect(1, '[data-game-source]');
    const voice = inspect(2, '[data-voice-mode]');
    const network = inspect(4, '[data-network]');
    state.step = 0;
    state.wbModels = [{id:'demo-model',name:'示例模型',credits:'1 积分',contextWindow:32000}];
    render();
    return { model, emptyState, game, voice, network };
  })()`);
  for (const [name, group] of Object.entries({
    model: componentHierarchy.model,
    game: componentHierarchy.game,
    voice: componentHierarchy.voice,
    network: componentHierarchy.network
  })) {
    assert.equal(group.hasSegment, true, `${name} 选择需要使用统一分段组件`);
    assert.ok(group.count >= 2, `${name} 选择必须保留全部选项`);
    assert.equal(group.semantic, true, `${name} 选项必须是带 aria-pressed 的语义按钮`);
    assert.equal(group.selected, 1, `${name} 选择必须公开唯一当前项`);
  }
  assert.deepEqual(componentHierarchy.emptyState, { visible: true, open: true, detect: true, load: true }, 'WorkBuddy 空状态必须保留登录、检测和获取模型入口');
  const checkTimeline = await win.webContents.executeJavaScript(`(() => {
    state.step = 5;
    state.selfCheck = {
      ready: false,
      pending: 2,
      blockingFailures: 1,
      checks: [
        {id:'runtime', title:'运行环境', detail:'可以自动准备', status:'pending', blocking:true},
        {id:'world', title:'世界存档', detail:'需要用户选择', status:'choice', needsChoice:true, blocking:true},
        {id:'model', title:'AI 模型', detail:'已经就绪', status:'pass', ok:true, blocking:true},
        {id:'port', title:'本地端口', detail:'端口占用', status:'error', blocking:true}
      ]
    };
    state.preparing = false;
    render();
    const idle = {
      states: [...document.querySelectorAll('.ui-timeline-item')].map(node => node.dataset.state),
      busy: document.querySelectorAll('[aria-busy="true"] .ui-activity').length
    };
    state.preparing = true;
    render();
    const working = {
      busy: document.querySelectorAll('[aria-busy="true"] .ui-activity').length,
      label: document.querySelector('[aria-busy="true"]')?.textContent || ''
    };
    state.preparing = false;
    render();
    return {
      idle,
      working,
      cleared: document.querySelectorAll('[aria-busy="true"] .ui-activity').length
    };
  })()`);
  assert.deepEqual(checkTimeline.idle.states, ['repairable', 'choice', 'success', 'failure'], '自检时间线必须区分自动修复、用户选择、成功和失败');
  assert.equal(checkTimeline.idle.busy, 0, '空闲自检页面不能播放活动动画');
  assert.ok(checkTimeline.working.busy >= 1, '准备资源时必须显示真实活动状态');
  assert.match(checkTimeline.working.label, /正在准备/, '活动状态必须同时提供可见中文文字');
  assert.equal(checkTimeline.cleared, 0, '准备完成后必须清除活动状态');
  await win.webContents.executeJavaScript('state.step=0;render()');
  const normalMotion = await win.webContents.executeJavaScript(`(() => {
    const activeStep = document.querySelector('.step.active');
    const notice = document.getElementById('notice');
    notice.classList.remove('hidden');
    return {
      activeName: getComputedStyle(activeStep).animationName,
      activeDuration: getComputedStyle(activeStep).animationDuration,
      activeIterations: getComputedStyle(activeStep).animationIterationCount,
      noticeName: getComputedStyle(notice).animationName,
      noticeDuration: getComputedStyle(notice).animationDuration,
      noticeIterations: getComputedStyle(notice).animationIterationCount
    };
  })()`);
  assert.notEqual(normalMotion.activeName, 'none', '当前步骤应有一次性按压回弹动画');
  assert.notEqual(normalMotion.activeDuration, '0s', '当前步骤动画必须具有可感知时长');
  assert.equal(normalMotion.activeIterations, '1', '当前步骤动画不能持续循环');
  assert.notEqual(normalMotion.noticeName, 'none', '状态提示应有一次性进入动画');
  assert.notEqual(normalMotion.noticeDuration, '0s', '状态提示动画必须具有可感知时长');
  assert.equal(normalMotion.noticeIterations, '1', '状态提示动画不能持续循环');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await win.webContents.debugger.sendCommand('DOM.enable');
  await win.webContents.debugger.sendCommand('CSS.enable');
  const documentNode = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const focusNode = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#next' });
  await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: focusNode.nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
  const full = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.card');
    const step = document.querySelector('.step');
    const activeStep = document.querySelector('.step.active');
    const restingStep = document.querySelectorAll('.step')[1];
    const button = document.getElementById('next');
    const sidebar = document.querySelector('.sidebar');
    const brand = document.querySelector('.brand');
    const body = document.body;
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      cardBlur: getComputedStyle(card).backdropFilter,
      reducedTransition: getComputedStyle(step).transitionDuration,
      activeAnimationDuration: getComputedStyle(document.querySelector('.step.active')).animationDuration,
      noticeAnimationDuration: getComputedStyle(document.getElementById('notice')).animationDuration,
      focusOutline: getComputedStyle(button).outlineStyle,
      focusWidth: getComputedStyle(button).outlineWidth,
      nonSemanticChoices: document.querySelectorAll('.selectable:not(button)').length,
      nonSemanticModelRows: document.querySelectorAll('.model-row:not(button)').length,
      sidebarBackground: getComputedStyle(sidebar).backgroundColor,
      brandColor: getComputedStyle(brand).color,
      restingStepShadow: getComputedStyle(restingStep).boxShadow,
      activeStepShadow: getComputedStyle(step).boxShadow,
      activeStepBackground: getComputedStyle(step).backgroundColor,
      activeStepNumberBackground: getComputedStyle(activeStep.querySelector('.step-number')).backgroundColor,
      activeStepNumberColor: getComputedStyle(activeStep.querySelector('.step-number')).color,
      bodyBackgroundImage: getComputedStyle(body).backgroundImage,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      cardRadius: getComputedStyle(card).borderRadius,
      cardBorderStyle: getComputedStyle(card).borderStyle,
      primaryBackgroundImage: getComputedStyle(button).backgroundImage,
      primaryBackground: getComputedStyle(button).backgroundColor
    };
  })()`);
  assert.equal(full.horizontalOverflow, false, '标准窗口不应出现横向滚动');
  assert.equal(full.cardBlur, 'none', '内容卡片不能依赖大面积背景模糊');
  assert.equal(full.reducedTransition, '0s', '减少动态效果时应关闭步骤动画');
  assert.equal(full.activeAnimationDuration, '0s', '减少动态效果时应关闭当前步骤回弹');
  assert.equal(full.noticeAnimationDuration, '0s', '减少动态效果时应关闭提示进入动画');
  assert.notEqual(full.focusOutline, 'none', '键盘焦点必须可见');
  assert.notEqual(full.focusWidth, '0px', '键盘焦点必须有明确宽度');
  assert.equal(full.nonSemanticChoices, 0, '可选卡片必须是可键盘操作的语义按钮');
  assert.equal(full.nonSemanticModelRows, 0, '模型列表项必须是可键盘操作的语义按钮');
  assertLight(full.sidebarBackground, '左侧导航必须使用浅色表面');
  assertDark(full.brandColor, '浅色侧栏品牌文字必须保持深色对比');
  assert.equal(full.bodyBackgroundImage, 'none', '主窗口背景应使用克制的纯色表面');
  assert.equal(full.accent, '#6fa6d9', '主窗口强调色应为低饱和浅蓝');
  assert.ok(parseFloat(full.cardRadius) <= 16, `卡片圆角应收敛到 16px 以内：${full.cardRadius}`);
  assert.equal(full.cardBorderStyle, 'solid', '白色卡片必须依靠清晰细边框建立层级');
  assert.equal(full.primaryBackgroundImage, 'none', '主要按钮不应使用渐变');
  assertDark(full.primaryBackground, '主要按钮应使用正式的深灰黑表面');
  assert.equal(full.activeStepNumberBackground, 'rgb(63, 111, 157)', '白色步骤编号必须使用高对比深蓝灰底色');
  assert.equal(full.activeStepNumberColor, 'rgb(255, 255, 255)', '当前步骤编号文字应保持白色');
  assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('next')).outlineColor"), 'rgb(63, 111, 157)', '键盘焦点应使用高对比深蓝灰');
  assert.doesNotMatch(full.activeStepShadow, /inset/, '当前步骤不应继续使用明显内凹拟态阴影');
  assertLight(full.activeStepBackground, '当前步骤仍应保持浅色表面');

  await win.webContents.executeJavaScript('state.step=6;render()');
  const summary = await win.webContents.executeJavaScript(`(() => {
    const node = document.querySelector('.summary-address');
    return { background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color };
  })()`);
  assertLight(summary.background, '服务器地址卡必须使用浅色表面');
  assertDark(summary.color, '服务器地址卡文字必须使用深色高对比文本');

  win.setSize(980, 680);
  await new Promise(resolve => setTimeout(resolve, 120));
  const compact = await win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('.grid');
    const footer = document.querySelector('main > footer');
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      footerVisible: footer.getBoundingClientRect().bottom <= innerHeight,
      footerBottom: footer.getBoundingClientRect().bottom,
      innerHeight,
      shellBottom: document.querySelector('.shell').getBoundingClientRect().bottom,
      mainRect: document.querySelector('main').getBoundingClientRect().toJSON(),
      contentRect: document.getElementById('content').getBoundingClientRect().toJSON(),
      footerRect: footer.getBoundingClientRect().toJSON(),
      mainRows: getComputedStyle(document.querySelector('main')).gridTemplateRows,
      cardRadius: getComputedStyle(document.querySelector('.card')).borderRadius,
      sidebarRadius: getComputedStyle(document.querySelector('.sidebar')).borderRadius,
      summaryRadius: getComputedStyle(document.querySelector('.summary-address')).borderRadius
    };
  })()`);
  assert.equal(compact.horizontalOverflow, false, '最小窗口不应出现横向滚动');
  assert.equal(compact.columns, 1, '最小窗口中的双列配置应折叠为单列');
  assert.equal(compact.footerVisible, true, `最小窗口仍应保留底部主操作：${JSON.stringify(compact)}`);
  assert.ok(parseFloat(compact.cardRadius) <= 16, `最小窗口卡片圆角不应重新放大：${compact.cardRadius}`);
  assert.ok(parseFloat(compact.sidebarRadius) <= 16, `最小窗口侧栏圆角不应重新放大：${compact.sidebarRadius}`);
  assert.ok(parseFloat(compact.summaryRadius) <= 16, `监管中心地址卡圆角应保持克制：${compact.summaryRadius}`);
  return win;
}

async function inspectButlerWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    show: false,
    webPreferences: { offscreen: true }
  });
  await win.loadFile(path.join(__dirname, '../src/renderer/build-chat.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  });
  const normalMotion = await win.webContents.executeJavaScript(`(() => {
    const assistantMessage = document.createElement('article');
    assistantMessage.className = 'message assistant';
    document.body.append(assistantMessage);
    return {
      name: getComputedStyle(assistantMessage).animationName,
      duration: getComputedStyle(assistantMessage).animationDuration,
      iterations: getComputedStyle(assistantMessage).animationIterationCount
    };
  })()`);
  assert.notEqual(normalMotion.name, 'none', '管家消息应有一次性进入动画');
  assert.notEqual(normalMotion.duration, '0s', '管家消息动画必须具有可感知时长');
  assert.equal(normalMotion.iterations, '1', '管家消息动画不能持续循环');
  const composerActivity = await win.webContents.executeJavaScript(`(() => {
    setComposerActivity({ active: true, label: '正在整理建造需求' });
    const active = {
      busy: document.querySelector('.composer').getAttribute('aria-busy'),
      label: document.getElementById('status').textContent,
      indicator: document.querySelectorAll('#status .ui-activity').length
    };
    setComposerActivity({ active: false, label: '已完成' });
    return {
      active,
      clearedBusy: document.querySelector('.composer').getAttribute('aria-busy'),
      clearedIndicator: document.querySelectorAll('#status .ui-activity').length,
      clearedLabel: document.getElementById('status').textContent
    };
  })()`);
  assert.equal(composerActivity.active.busy, 'true', '管家请求处理中必须公开忙碌状态');
  assert.match(composerActivity.active.label, /正在整理建造需求/, '管家请求处理中必须显示清楚的中文提示');
  assert.equal(composerActivity.active.indicator, 1, '管家请求处理中必须显示活动指示器');
  assert.equal(composerActivity.clearedBusy, 'false', '管家请求完成后必须清除忙碌状态');
  assert.equal(composerActivity.clearedIndicator, 0, '管家请求完成后必须停止活动指示器');
  assert.equal(composerActivity.clearedLabel, '已完成', '管家请求完成后必须保留结果提示');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  await win.webContents.debugger.sendCommand('DOM.enable');
  await win.webContents.debugger.sendCommand('CSS.enable');
  const documentNode = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const focusNode = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#send' });
  await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: focusNode.nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
  win.setSize(980, 680);
  await new Promise(resolve => setTimeout(resolve, 120));
  const result = await win.webContents.executeJavaScript(`(() => {
    const intro = document.querySelector('.intro');
    const mode = document.querySelector('.mode-card');
    const send = document.getElementById('send');
    const userMessage = document.createElement('article');
    userMessage.className = 'message user';
    document.body.append(userMessage);
    const execute = document.getElementById('execute');
    const body = document.body;
    setComposerActivity({ active: true, label: '正在测试' });
    const activity = document.querySelector('#status .ui-activity');
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      introBlur: getComputedStyle(intro).backdropFilter,
      reducedTransition: getComputedStyle(mode).transitionDuration,
      messageAnimationDuration: getComputedStyle(userMessage).animationDuration,
      focusOutline: getComputedStyle(send).outlineStyle,
      modeStatesNamed: [...document.querySelectorAll('[data-mode]')].every(button => button.hasAttribute('aria-pressed')),
      userMessageBackground: getComputedStyle(userMessage).backgroundColor,
      userMessageColor: getComputedStyle(userMessage).color,
      executeBackground: getComputedStyle(execute).backgroundColor,
      executeColor: getComputedStyle(execute).color,
      activityAnimationDuration: getComputedStyle(activity).animationDuration,
      bodyBackgroundImage: getComputedStyle(body).backgroundImage,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      introRadius: getComputedStyle(intro).borderRadius,
      sendBackgroundImage: getComputedStyle(send).backgroundImage,
      sendBackground: getComputedStyle(send).backgroundColor,
      focusColor: getComputedStyle(send).outlineColor,
      eyebrowColor: getComputedStyle(document.querySelector('.eyebrow')).color,
      composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
      sendBottom: send.getBoundingClientRect().bottom,
      innerHeight
    };
  })()`);
  assert.equal(result.horizontalOverflow, false, '管家模式不应横向溢出');
  assert.equal(result.introBlur, 'none', '管家模式不能依赖大面积背景模糊');
  assert.equal(result.reducedTransition, '0s', '管家模式应尊重减少动态效果');
  assert.equal(result.messageAnimationDuration, '0s', '减少动态效果时应关闭消息进入动画');
  assert.equal(result.activityAnimationDuration, '0s', '减少动态效果时应关闭管家活动动画');
  assert.equal(result.bodyBackgroundImage, 'none', '管家窗口背景应使用克制的纯色表面');
  assert.equal(result.accent, '#6fa6d9', '管家窗口应共享低饱和浅蓝强调色');
  assert.ok(parseFloat(result.introRadius) <= 16, `管家卡片圆角应收敛到 16px 以内：${result.introRadius}`);
  assert.equal(result.sendBackgroundImage, 'none', '管家发送按钮不应使用渐变');
  assertDark(result.sendBackground, '管家发送按钮应使用正式的深灰黑表面');
  assert.equal(result.focusColor, 'rgb(63, 111, 157)', '管家键盘焦点应使用高对比深蓝灰');
  assert.equal(result.eyebrowColor, 'rgb(63, 111, 157)', '管家小字号强调文字应使用高对比深蓝灰');
  assert.ok(result.composerBottom <= result.innerHeight, `980×680 下管家输入区必须完整可见：${JSON.stringify(result)}`);
  assert.ok(result.sendBottom <= result.innerHeight, `980×680 下发送按钮必须完整可见：${JSON.stringify(result)}`);
  assert.notEqual(result.focusOutline, 'none', '管家模式键盘焦点必须可见');
  assert.equal(result.modeStatesNamed, true, '管家模式选择应向辅助技术公开选中状态');
  assertLight(result.userMessageBackground, '用户消息必须使用浅色表面');
  assertDark(result.userMessageColor, '浅色用户消息必须使用深色文字');
  assertLight(result.executeBackground, '管理员执行按钮必须使用浅色表面');
  assertDark(result.executeColor, '浅色管理员执行按钮必须使用深色文字');
  return win;
}

app.whenReady().then(async () => {
  assertSharedUiSources();
  installMainFixtures();
  const mainWindow = await inspectMainWindow();
  const butlerWindow = await inspectButlerWindow();
  console.log('renderer visual accessibility and responsive smoke test passed');
  butlerWindow.destroy();
  mainWindow.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
