// Actual Electron/preload/IPC checks for the extracted editor and conversation rows.
// No personal data, credentials, external provider or native device is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
const repo=path.resolve(import.meta.dirname,'..'),out=path.resolve(repo,process.env.HEMI_UI_EVIDENCE_DIR??'.visual/workflow/shared-ui/desktop');await fs.mkdir(out,{recursive:true});
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
try{for(const mode of ['dev','built']){
 const userData=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-shared-ui-'));
 await fs.writeFile(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
 const server=mode==='dev'?await createServer({configFile:path.join(repo,'vite.config.ts'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}}):null;if(server)await server.listen();
 const result={mode,userData,checks:[],errors:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};let app;
 try{
  const env={...process.env,HEMI_USER_DATA_DIR:userData};if(server)env.VITE_DEV_SERVER_URL=server.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
  app=await _electron.launch({executablePath:electronPath,args:['.'],env});
  let page;const deadline=Date.now()+20000;
  while(!page&&Date.now()<deadline){page=app.windows().find(candidate=>{try{const url=new URL(candidate.url());return url.protocol!=='about:'&&!url.searchParams.has('mode');}catch{return false;}});if(!page)await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(page,'main renderer window appears');page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
  result.url=page.url();

  const input=page.getByRole('textbox',{name:'输入消息',exact:true});await input.waitFor();await page.waitForFunction(()=>document.querySelector('.appearance-stage')?.dataset.startup==='done');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(win=>!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(1,1);win.setContentSize(1440,900);win.show();win.focus();});await page.bringToFront();
  await page.locator('.h24-empty[data-state-view="empty"]').waitFor();await page.screenshot({path:path.join(out,mode+'-empty-1440.png')});check('desktop welcome uses the shared empty state before any persisted conversation exists');
  await page.evaluate(async()=>{for(let i=1;i<=2;i++){const id='conv-shared-ui-'+i;const saved=await window.hemiVoice.saveConversation({id,turns:[{id:id+'-u',author:'user',text:'隔离检查消息 '+i,createdAt:Date.now()},{id:id+'-a',author:'hemi',text:'隔离检查回复 '+i,createdAt:Date.now()}]});if(!saved.ok)throw new Error('Failed to save fixture');await window.hemiVoice.renameConversation(id,'共享会话 '+i);}});
  const row=page.locator('.h24-sidebar-open').filter({hasText:'共享会话 1'});await row.waitFor();await row.dblclick();const rename=page.getByRole('textbox',{name:'重命名会话',exact:true});await rename.fill('共享重命名验证');await rename.press('Enter');await page.locator('.h24-sidebar-open').filter({hasText:'共享重命名验证'}).waitFor();
  assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.find(item=>item.id==='conv-shared-ui-1').title),'共享重命名验证');check('shared row rename persists through actual desktop IPC');
  await page.locator('.h24-sidebar-open').filter({hasText:'共享重命名验证'}).click();await page.waitForFunction(()=>document.querySelector('.h24-conversation-title').textContent==='共享重命名验证');await page.getByText('隔离检查回复 1',{exact:true}).waitFor();check('shared navigation opens real persisted history and the shared message flow');
  await input.fill('跨设置页保留的共享输入草稿');await page.getByRole('button',{name:'设置',exact:true}).click();await input.waitFor({state:'hidden'});await page.getByRole('button',{name:'对话',exact:true}).click();await input.waitFor();assert.equal(await input.inputValue(),'跨设置页保留的共享输入草稿');check('shared composer retains the bound draft through page unmount/remount');
  await page.getByRole('button',{name:'查看全部会话',exact:true}).click();
  const history=page.getByRole('dialog',{name:'历史会话',exact:true});await history.waitFor();
  const historyRow=()=>history.locator('.history-item').filter({has:page.locator('.history-item-main').filter({hasText:'共享重命名验证'})});
  assert.ok((await historyRow().textContent()).includes('2 条'));
  await historyRow().click({button:'right'});await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
  let historyRename=history.getByRole('textbox',{name:'重命名会话',exact:true});await historyRename.fill('取消历史编辑');await historyRename.press('Escape');await historyRename.waitFor({state:'hidden'});await page.waitForTimeout(350);assert.equal(await history.isVisible(),true,'Escape cancels only the rename editor');
  assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.find(item=>item.id==='conv-shared-ui-1').title),'共享重命名验证');
  await historyRow().click({button:'right'});await page.getByRole('menuitem',{name:'重命名',exact:true}).click();historyRename=history.getByRole('textbox',{name:'重命名会话',exact:true});await historyRename.fill('历史共享条目验证');await historyRename.press('Enter');await historyRename.waitFor({state:'hidden'});
  const historyOpen=history.locator('.history-item-main').filter({hasText:'历史共享条目验证'});await historyOpen.waitFor();assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.find(item=>item.id==='conv-shared-ui-1').title),'历史共享条目验证');
  await page.screenshot({path:path.join(out,mode+'-history-1440.png')});await historyOpen.click();await history.waitFor({state:'hidden'});await input.waitFor();assert.equal(await input.inputValue(),'跨设置页保留的共享输入草稿');check('shared history row preserves metadata, Escape cancellation, rename IPC and opening with the current draft');
  await page.evaluate(async()=>{const id='conv-history-delete';await window.hemiVoice.saveConversation({id,turns:[{id:id+'-u',author:'user',text:'历史删除验证',createdAt:Date.now()}]});await window.hemiVoice.renameConversation(id,'历史删除验证');});
  await page.getByRole('button',{name:'查看全部会话',exact:true}).click();await history.waitFor();const deleteHistory=history.getByRole('button',{name:'删除会话 历史删除验证',exact:true});await deleteHistory.click();assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.some(item=>item.id==='conv-history-delete')),true);await deleteHistory.click();await deleteHistory.waitFor({state:'hidden'});assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.some(item=>item.id==='conv-history-delete')),false);await page.keyboard.press('Escape');await history.waitFor({state:'hidden'});check('history row keeps two-step deletion against actual persisted records');
  const beforeOrder=await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.map(item=>item.id));
  await page.locator('.h24-sidebar-item').first().focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowDown');await page.keyboard.press('Space');
  await page.waitForFunction(async before=>{const ids=(await window.hemiVoice.listConversations()).sessions.map(item=>item.id);return ids[0]===before[1]&&ids[1]===before[0];},beforeOrder);check('shared group container preserves keyboard drag ordering through actual IPC');
  const remove=page.locator('.h24-sidebar-open').filter({hasText:'共享会话 2'});await remove.click({button:'right'});const deletion=page.getByRole('menuitem').filter({hasText:'删除'});await deletion.click();assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.some(item=>item.id==='conv-shared-ui-2')),true);await page.getByRole('menuitem').filter({hasText:'确认删除'}).click();await remove.waitFor({state:'hidden'});assert.equal(await page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions.some(item=>item.id==='conv-shared-ui-2')),false);check('portalled context menu retains two-step deletion through actual desktop IPC');
  await page.screenshot({path:path.join(out,mode+'-1440.png')});
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(win=>!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setContentSize(375,812);});await page.waitForFunction(()=>innerWidth===375);await page.getByRole('button',{name:'打开导航',exact:true}).click();await page.locator('.h24-sidebar-open').filter({hasText:'历史共享条目验证'}).waitFor();await page.screenshot({path:path.join(out,mode+'-375.png')});await page.locator('.h24-sidebar-open').filter({hasText:'历史共享条目验证'}).click();await input.waitFor();assert.equal(await input.inputValue(),'跨设置页保留的共享输入草稿');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);check('375px explicit drawer selection preserves draft and fits the viewport');
  assert.deepEqual(result.errors,[]);check('no renderer errors');
 }catch(error){result.error=error.stack;if(app)result.windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(win=>({id:win.id,url:win.webContents.getURL(),visible:win.isVisible()})));if(app)await (await app.firstWindow()).screenshot({path:path.join(out,mode+'-failure.png')}).catch(()=>{});throw error;}finally{await app?.close();await server?.close();}
}}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
