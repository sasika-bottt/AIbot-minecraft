// Isolated, mocked UI render; writes screenshots only into the chosen temp directory.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1060, height: 800, show: false, webPreferences: { offscreen:true, preload:path.join(__dirname,'survival-preview-preload.cjs'), contextIsolation:true, sandbox:true } });
  await win.loadFile(path.join(__dirname,'../src/renderer/build-chat.html'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  fs.writeFileSync(path.join(process.env.TEMP,'minebot-build-ui.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.getElementById('survival-preview').click()");
  await new Promise(resolve => setTimeout(resolve, 500));
  const preview = await win.webContents.executeJavaScript("({open:document.getElementById('blueprint-dialog').open,text:document.getElementById('blueprint-summary').textContent,disabled:document.getElementById('start-survival').disabled})");
  assert.equal(preview.open,true); assert.match(preview.text,/主世界/); assert.match(preview.text,/5, 64, 0.*泥土/); assert.equal(preview.disabled,false);
  fs.writeFileSync(path.join(process.env.TEMP,'minebot-build-dialog.png'), (await win.webContents.capturePage()).toPNG());
  const disabled = await win.webContents.executeJavaScript("document.getElementById('blueprint-json').value='invalid'; document.getElementById('blueprint-json').dispatchEvent(new Event('input')); document.getElementById('start-survival').disabled");
  assert.equal(disabled,true);
  console.log('survival UI preview test passed');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
