// 独立进程只读恢复真实模型任务，点击同一成果；请求账本前后对账，不发送新模型请求。
import { app, Menu } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { installNativeShell } from '../src/main/windows/native-shell.mjs';
import { state } from '../src/main/state.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
const ud=process.env.HEMI_USER_DATA_DIR;if(!ud)throw Error('必须提供隔离的 HEMI_USER_DATA_DIR');
const cid=process.env.HEMI_REVIEW_CONVERSATION??'conv-064-real-new',artifact=process.env.HEMI_REVIEW_ARTIFACT??'result-new.md',marker=process.env.HEMI_REVIEW_MARKER??'HEMI_064_REAL_NEW_OK',variant=process.env.HEMI_REVIEW_VARIANT??'real';
const expectedRoles=(process.env.HEMI_REVIEW_ROLES??'explorer,oracle,fixer').split(',').filter(Boolean);
const entry=process.env.HEMI_REVIEW_ENTRY??'chip';
app.setName('hemi');app.setPath('userData',ud);
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),output=path.resolve('.visual/workflow/vision');await mkdir(output,{recursive:true});
const evidence={rendererUrl:null,checks:[],screenshots:[],errors:[]};
const exec=code=>state.mainWindow.webContents.executeJavaScript(code),js=JSON.stringify;
const check=(name,ok)=>{evidence.checks.push({name,pass:!!ok});assert.ok(ok,name);};
const wait=async(fn,label)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await sleep(100);}throw Error(label);};
const journal=()=>readFile(path.join(ud,'runtime-v2/run-journal.json'),'utf8').then(JSON.parse);
async function shot(name,width=1440){state.mainWindow.setMinimumSize(300,400);state.mainWindow.setContentSize(width,900);state.mainWindow.show();await sleep(600);const file=path.join(output,`064-${variant}-${name}-${width}.png`);await writeFile(file,(await state.mainWindow.webContents.capturePage()).toPNG());evidence.screenshots.push(file);check(`${name}-${width} 不溢出`,await exec('document.documentElement.scrollWidth<=innerWidth'));}
app.whenReady().then(async()=>{try{
 const countBefore=Object.keys((await journal()).requests).length;
 initializeStableSafeStorageIdentity();await registerAllIpcHandlers();installNativeShell({app,Menu,platform:process.platform,appName:'Hemi',devTools:true});
 app.on('web-contents-created',(_event,contents)=>contents.on('console-message',event=>{if(event.level==='error')evidence.errors.push(event.message);}));
 await createMainWindow();state.mainWindow.show();evidence.rendererUrl=state.mainWindow.webContents.getURL();
 const archive=JSON.parse(await readFile(path.join(ud,'runtime-v2/conversations',`${cid}.json`),'utf8'));
 await wait(()=>exec(`!![...document.querySelectorAll('.h24-sidebar-open')].find(e=>e.title.startsWith(${js(archive.title)}))`),'会话列表就绪');
 await exec(`[...document.querySelectorAll('.h24-sidebar-open')].find(e=>e.title.startsWith(${js(archive.title)})).click()`);
 await wait(()=>exec(`document.body.innerText.includes(${js(artifact)})`),'真实会话恢复');
 check('重启后显示本次实际派出的角色',await exec(`(()=>{const rows=[...document.querySelectorAll('.h56-delegation')];return rows.length===${expectedRoles.length}&&${js(expectedRoles)}.every(name=>rows.some(e=>e.dataset.agent===name))})()`));
 if(variant==='concise')check('用户要求的链接与结论实际分行',await exec(`(()=>{const a=[...document.querySelectorAll('.assistant-copy .md a')].find(e=>e.textContent.includes(${js(artifact)}));const p=a?.closest('p');if(!p)return false;const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const i=node.textContent.indexOf('结论：');if(i<0)continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+3);return range.getBoundingClientRect().top>=a.getBoundingClientRect().bottom-1;}return false})()`));
 await shot('conversation');await shot('conversation',375);await shot('conversation',768);await shot('conversation');
 check('真实成果入口可点击',await exec(`(()=>{const e=[...document.querySelectorAll(${js(entry==='link'?'a':'button.h62-deliverable-chip')})].find(e=>e.textContent.includes(${js(artifact)}));if(!e)return false;e.click();return true})()`));
 await wait(()=>exec(`!![...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${js('关闭 '+artifact)})&&[...document.querySelectorAll('[role="tabpanel"],.h24-preview-content')].some(e=>e.textContent.includes(${js(marker)}))`),'成果内容正确');
 await shot('preview');await shot('preview',375);
 await exec(`[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${js('关闭 '+artifact)}).click()`);check('成果关闭后返回对话',await exec(`!!document.querySelector('textarea[aria-label="输入消息"]')`));
 check('无 renderer 错误',evidence.errors.length===0);check('只读恢复未触发新模型请求',Object.keys((await journal()).requests).length===countBefore);
}catch(error){evidence.error=error.stack;console.error(error.stack);if(state.mainWindow){evidence.visibleText=await exec('document.body.innerText');await shot('failure').catch(()=>{});}}finally{
 evidence.passed=!evidence.error;await writeFile(path.join(output,`064-${variant}-review.json`),JSON.stringify(evidence,null,2));console.log('HEMI_064_REAL_REVIEW='+JSON.stringify(evidence));disposeTaskManager();getAgentRuntime().disposeAll();state.isQuitting=true;setTimeout(()=>app.exit(evidence.passed?0:1),300);
}});
