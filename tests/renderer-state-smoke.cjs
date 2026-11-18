const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFAULT_CONFIG } = require('../src/services/config-store.cjs');

async function main() {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, classList: { add() {} } });
    return nodes.get(id);
  };
  const stepButton = element('step'); stepButton.dataset.step = '5';
  let saved;
  const context = vm.createContext({
    document: {
      querySelector: selector => element(selector.slice(1)),
      getElementById: id => nodes.get(id) || null,
      querySelectorAll: selector => selector === '[data-step]' ? [stepButton] : []
    },
    window: { whale: { saveConfig: async config => { saved = structuredClone(config); return structuredClone(config); } } },
    setTimeout: () => 0, clearTimeout() {}, console
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('\n(async () => {')), context);
  context.initial = structuredClone(DEFAULT_CONFIG);
  vm.runInContext('state.config = initial; state.step = 1; render = () => {};', context);
  element('server-template-path').value = 'D:\\example-server';
  vm.runInContext('renderSteps()', context);
  await stepButton.listeners.click();
  assert.equal(saved.server.templatePath, 'D:\\example-server');
  assert.equal(vm.runInContext('state.step', context), 5);
  vm.runInContext('state.step = 6; bind()', context);
  const behavior = { dataset: { toggle: 'selfDefense' }, checked: false };
  context.document.querySelectorAll = selector => selector === '[data-toggle]' ? [behavior] : [];
  element('content').listeners.change();
  assert.equal(vm.runInContext('state.config.behavior.selfDefense', context), false, '监管轮询前必须保留开关编辑');
  vm.runInContext("state.config.game={...state.config.game,minecraftVersion:'1.20.1',modLoader:'forge',loaderVersion:'47.4.23',javaMajor:17,worldPath:'old-world'};state.config.server.templatePath='old-template';applyInstance('new-pack',{minecraftVersion:'1.21.11',modLoader:'vanilla',javaMajor:21})", context);
  assert.equal(vm.runInContext('state.config.game.modLoader', context), 'vanilla');
  assert.equal(vm.runInContext('state.config.server.templatePath', context), '');
  assert.equal(vm.runInContext('state.config.game.worldPath', context), '');
  vm.runInContext("applyInstance('unknown-pack',{});", context);
  assert.equal(vm.runInContext('state.config.game.minecraftVersion', context), '', '无法识别的新实例不能沿用旧版本');
  const beforeSave = saved;
  vm.runInContext('state.preparing=true;', context);
  await vm.runInContext('navigate(1)', context);
  assert.equal(saved, beforeSave, '准备期间底部导航也不能保存并切换配置');
  vm.runInContext('state.preparing=false;', context);
  context.window.whale.serverStatus = async () => { throw Error('temporary IPC error'); };
  context.window.whale.botStatus = async () => ({ ready: false });
  context.window.whale.sakuraStatus = async () => ({ game: {}, voice: {} });
  await vm.runInContext('refreshRuntimeStatus()', context);
  assert.equal(vm.runInContext('state.serverStatus.ready', context), false);
  assert.equal(vm.runInContext('state.serverStatus.busy', context), true);
  context.window.whale.serverStatus = async () => ({ ready: true, busy: false });
  await vm.runInContext('refreshRuntimeStatus()', context);
  assert.equal(vm.runInContext('state.serverStatus.ready', context), true);
  assert.equal(vm.runInContext('state.statusError', context), '');
  console.log('renderer navigation and draft preservation smoke test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
