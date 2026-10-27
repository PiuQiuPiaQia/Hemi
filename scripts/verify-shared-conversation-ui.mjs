// Public package APIs in a standalone consumer. The platform boundaries are controlled fixtures.
// Actual Bot filesystem/transport and desktop IPC are covered by the application checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer, build, preview} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import {chromium} from 'playwright-core';
const repo=path.resolve(import.meta.dirname,'..'),out=path.join(repo,'.visual/workflow/shared-ui/components'),root=path.join(out,'consumer');
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'index.html'),'<html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script type="module" src="/main.tsx"></script></html>');
await fs.writeFile(path.join(root,'main.tsx'),String.raw`
import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationComposer} from '@hemi/conversation-flow/composer';
import {ModelSelectorChip,ThinkingLevelStrip,ModelSelectorControl} from '@hemi/conversation-flow/controls';
import {DirectoryPicker,ConversationRow} from '@hemi/conversation-flow/navigation';
import {ResourcePreview} from '@hemi/conversation-flow/resources';
import {ConversationFlowProvider} from '@hemi/conversation-flow/parts';
import ${JSON.stringify(path.join(repo,'src/renderer/src/globals.css'))};
import ${JSON.stringify(path.join(repo,'src/renderer/src/styles/index.css'))};
import '@hemi/conversation-flow/styles.css';
const directory={version:2,defaultModelId:'p/ready',roleModels:{main:'p/ready'},providers:[{id:'p',name:'Provider',baseUrl:'https://example.invalid',api:'openai-completions',hasApiKey:true,keyStoredSecurely:false,updatedAt:0,models:[{id:'ready',modelKey:'p/ready',model:'Ready',thinkingLevel:'default',supportsVision:false,visionModel:''},{id:'blocked',modelKey:'p/blocked',model:'Blocked',thinkingLevel:'default',supportsVision:false,visionModel:'',unavailableReason:'此模型已被停用'}]}]};
const state=window.__uiHarness={sent:0,stops:0,releases:0,mentions:[],read:null,folder:null};
const adapter={listSlashCandidates:async()=>({commands:[{id:'model',name:'/model',description:'切换模型'}],skills:[{skillId:'skill-one',name:'检查技能',description:'保留标签身份',source:'library'}]}),listReferences:(_id,query)=>new Promise(resolve=>state.mentions.push({query,resolve})),automaticRouting:true};
const host={resources:{read:()=>new Promise(resolve=>{state.read=()=>resolve({ok:true,value:{ref:{id:'one',version:'1'},content:{kind:'text',mimeType:'text/plain',text:'文件正文'},release:()=>state.releases++}});}),listActions:async()=>({ok:true,value:[]})}};
const scope={environmentId:'test',conversationId:'one',generation:'1'};
const load=async(path,signal)=>path==='/slow'?new Promise(resolve=>{state.folder=()=>resolve({path:'/slow',parent:'/',home:'/',folders:[]});}):({path,parent:'/',home:'/',folders:[{name:'slow',path:'/slow'},{name:'fast',path:'/fast'}]});
function App(){
 const [choice,setChoice]=useState('first'),[choiceSaving,setChoiceSaving]=useState(false),[choiceError,setChoiceError]=useState('');
 const [text,setText]=useState(''),[skills,setSkills]=useState([]),[references,setReferences]=useState([]),[model,setModel]=useState('p/ready'),[level,setLevel]=useState('default'),[blocked,setBlocked]=useState(false),[touch,setTouch]=useState(false),[busy,setBusy]=useState(false),[resource,setResource]=useState(false),[folder,setFolder]=useState(false),[rowEditing,setRowEditing]=useState(false),[rowDraft,setRowDraft]=useState('会话标题');
 Object.assign(state,{setBlocked,setTouch,setBusy,setText,setResource,setFolder});
 return <main className="compact-shell" style={{padding:32,maxWidth:900,margin:'auto',minHeight:'100vh'}}>
  <section style={{height:40,display:'flex',alignItems:'center',gap:16}}><ModelSelectorChip directory={directory} currentProfileId={model} onSelect={setModel}/><ThinkingLevelStrip level={level} onChange={setLevel}/></section>
  <div data-model={model} data-level={level} data-choice={choice}/>
  <ModelSelectorControl layout="touch" label="共享模型选择" models={[{id:'first',name:'First choice'},{id:'second',name:'Second choice'}]} selected={choice} saving={choiceSaving} error={choiceError} onSelect={async value=>{setChoiceSaving(true);setChoiceError('');try{await new Promise(resolve=>{state.choiceRelease=resolve;});if(state.rejectChoice!==false){setChoiceError('保存失败，可重试');return false;}setChoice(value);}finally{setChoiceSaving(false);}}}/>
  <div className="h24-sidebar-item"><ConversationRow item={{id:'row',title:'会话标题',updatedAt:Date.now(),status:'running'}} current onOpen={()=>{}} editing={rowEditing} draft={rowDraft} onDraftChange={setRowDraft} onStartEdit={()=>setRowEditing(true)} onCancelEdit={()=>setRowEditing(false)} onCommitEdit={value=>{setRowDraft(value);setRowEditing(false);}}/></div>
  <ConversationComposer adapter={touch?undefined:adapter} layout={touch?'touch':'desktop'} value={text} onChange={setText} onSend={()=>state.sent++} busy={busy} pendingSpeech={false} modelReady callActive={false} onOpenSettings={()=>{}} sendBlocked={blocked} onStopTurn={()=>state.stops++} modelProfiles={directory} onSelectModelProfile={setModel} mentionConversationId="one" skills={skills} onSetSkills={setSkills} references={references} onSetReferences={setReferences} onAddReference={reference=>setReferences(previous=>[...previous,reference])}/>
  <button onClick={()=>setFolder(true)}>打开目录</button><button onClick={()=>setResource(true)}>打开资源</button>
  {folder?<DirectoryPicker path="/" recent={[]} load={load} saving={false} offline={false} onSelect={()=>setFolder(false)} onClose={()=>setFolder(false)}/>:null}
  <ConversationFlowProvider part scope={scope} host={host}>{resource?<ResourcePreview host={host} scope={scope} request={{ref:{id:'one',version:'1'}}} onClose={()=>setResource(false)} returnFocus={null}/>:null}</ConversationFlowProvider>
 </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
`);
const report={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:process.platform+'/'+process.arch,results:[]};
const common={configFile:false,root,base:'./',logLevel:'error',css:{postcss:{plugins:[tailwind()]}},resolve:{dedupe:['react','react-dom']}};
const browser=await chromium.launch({headless:true,executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{for(const mode of ['dev','built']){
 if(mode==='built')await build({...common,plugins:[react()],build:{outDir:path.join(root,'dist'),emptyOutDir:true}});
 const aliases={'@hemi/conversation-flow/styles':path.join(repo,'packages/conversation-flow/dist/styles'),'@hemi/conversation-flow/styles.css':path.join(repo,'packages/conversation-flow/dist/styles.css'),...Object.fromEntries(['core','react','parts','types','composer','controls','navigation','resources'].map(name=>['@hemi/conversation-flow/'+name,path.join(repo,'packages/conversation-flow/src',name+'.ts')])),'@hemi/conversation-flow':path.join(repo,'packages/conversation-flow/src/index.ts')};
 const server=mode==='dev'?await createServer({...common,plugins:[react()],resolve:{...common.resolve,alias:aliases},server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}}}):await preview({...common,preview:{host:'127.0.0.1',port:0}});
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);
 const result={mode,checks:[],errors:[]};report.results.push(result);const check=name=>{result.checks.push(name);console.log('PASS',mode,name);};page.on('pageerror',error=>result.errors.push(error.message));
 try{
  if(mode==='dev')await server.listen();await page.goto(server.resolvedUrls.local[0]);const input=page.getByRole('textbox',{name:'输入消息',exact:true});await input.waitFor();
  await input.fill('阻止发送');await page.evaluate(()=>window.__uiHarness.setBlocked(true));await input.press('Enter');assert.equal(await page.evaluate(()=>window.__uiHarness.sent),0);await page.evaluate(()=>window.__uiHarness.setBlocked(false));
  await input.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true})));assert.equal(await page.evaluate(()=>window.__uiHarness.sent),0);
  await input.press('Shift+Enter');assert.ok((await input.inputValue()).includes('\n'));await input.press('Enter');assert.equal(await page.evaluate(()=>window.__uiHarness.sent),1);check('desktop Enter/Shift+Enter, IME and blocked send semantics');
  await input.fill('/');await page.getByRole('menu',{name:'命令与技能'}).waitFor();await page.getByRole('menuitem').filter({hasText:'检查技能'}).click();await page.locator('.composer-inline-tag').waitFor();await input.press('Meta+z');assert.equal(await page.locator('.composer-inline-tag').count(),0);await input.press('Meta+Shift+z');await page.locator('.composer-inline-tag').waitFor();await input.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));check('skill identity, atomic editor and undo/redo survive the package boundary');
  await input.fill('/model');assert.equal(await input.inputValue(),'/model');await page.getByRole('menuitem').filter({hasText:'/model'}).click();await page.getByRole('menu',{name:'切换模型',exact:true}).waitFor();await page.getByRole('textbox',{name:'搜索模型',exact:true}).press('Escape');await page.getByRole('menu',{name:'命令与技能'}).waitFor();await input.press('Escape');assert.equal(await input.inputValue(),'/model');check('/model uses the shared editor and returns through both candidate levels without clearing text');
  await input.fill('@old');await page.waitForFunction(()=>window.__uiHarness.mentions.some(item=>item.query==='old'));await input.fill('@new');await page.waitForFunction(()=>window.__uiHarness.mentions.some(item=>item.query==='new'));
  await page.evaluate(()=>{const list=window.__uiHarness.mentions;for(const query of ['new','old'])list.find(item=>item.query===query).resolve({candidates:[{kind:'file',key:query,name:query,subtitle:query,resource:{id:query,version:'1'}}]});});
  await page.getByRole('menuitem').filter({hasText:'new'}).waitFor();assert.equal(await page.getByRole('menuitem').filter({hasText:'old'}).count(),0);await input.press('Escape');check('late reference results never replace the current query');
  await input.fill('');await page.locator('.h24-model-chip').click();const disabled=page.getByRole('menuitemradio').filter({hasText:'Blocked'});await disabled.waitFor();assert.equal(await disabled.isDisabled(),true);assert.equal(await disabled.getAttribute('title'),'此模型已被停用');await page.getByRole('searchbox').focus();await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
  await page.locator('.h37-tool').filter({has:page.locator('svg.lucide-brain')}).click();await page.getByRole('menuitemradio').filter({hasText:'高'}).click();await page.locator('[data-level="high"]').waitFor({state:'attached'});check('model availability reasons and thinking choices remain functional');
  const choiceTrigger=page.getByRole('button',{name:'共享模型选择',exact:true});await choiceTrigger.click();const choiceDialog=page.getByRole('dialog',{name:'选择模型',exact:true}),secondChoice=choiceDialog.getByRole('button',{name:/Second choice/});await secondChoice.click();await page.waitForFunction(()=>!!window.__uiHarness.choiceRelease);assert.equal(await secondChoice.isDisabled(),true);await page.evaluate(()=>window.__uiHarness.choiceRelease());await choiceDialog.getByRole('alert').waitFor();assert.equal(await choiceDialog.isVisible(),true);await page.evaluate(()=>{window.__uiHarness.rejectChoice=false;window.__uiHarness.choiceRelease=null;});await secondChoice.click();await page.waitForFunction(()=>!!window.__uiHarness.choiceRelease);await page.evaluate(()=>window.__uiHarness.choiceRelease());await choiceDialog.waitFor({state:'hidden'});await page.locator('[data-choice="second"]').waitFor({state:'attached'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='共享模型选择');check('shared selector keeps failed saves open, disables duplicate choices, retries successfully and restores focus');
  await page.getByRole('button',{name:'打开目录',exact:true}).click();const dialog=page.getByRole('dialog',{name:'选择工作目录'});await dialog.getByRole('button',{name:'slow',exact:true}).click();await page.waitForFunction(()=>!!window.__uiHarness.folder);const address=dialog.getByRole('textbox',{name:'服务器目录路径'});await address.fill('/fast');await dialog.getByRole('button',{name:'前往',exact:true}).click();await dialog.getByRole('button',{name:'使用此目录'}).waitFor();await page.evaluate(()=>window.__uiHarness.folder());assert.equal(await address.inputValue(),'/fast');await dialog.getByRole('button',{name:'关闭',exact:true}).click();check('directory reads are cancellable and late paths cannot overwrite navigation');
  await page.getByRole('button',{name:'打开资源',exact:true}).click();await page.waitForFunction(()=>!!window.__uiHarness.read);await page.getByRole('dialog',{name:'文件预览'}).getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>window.__uiHarness.read());await page.waitForFunction(()=>window.__uiHarness.releases>0);check('closing a preview releases a resource arriving after cancellation');
  await page.evaluate(()=>window.__uiHarness.setTouch(true));const touch=page.getByRole('textbox',{name:'消息',exact:true});await touch.fill('手机换行');const before=await page.evaluate(()=>window.__uiHarness.sent);await touch.press('Enter');assert.ok((await touch.inputValue()).endsWith('\n'));assert.equal(await page.evaluate(()=>window.__uiHarness.sent),before);await touch.press('Meta+Enter');assert.equal(await page.evaluate(()=>window.__uiHarness.sent),before+1);
  await page.evaluate(()=>window.__uiHarness.setBusy(true));await page.getByRole('button',{name:'停止任务',exact:true}).click();assert.equal(await page.evaluate(()=>window.__uiHarness.stops),1);await page.evaluate(()=>window.__uiHarness.setText('从队列取回的普通草稿'));await page.getByRole('button',{name:'加入待发送',exact:true}).waitFor();assert.equal(await page.locator('.composer-editing').count(),0);check('touch Enter inserts a line; modified Enter, ordinary draft send and separate stop retain their behavior');
  assert.deepEqual(result.errors,[]);await page.screenshot({path:path.join(out,mode+'.png')});
 }catch(error){result.error=error.stack;await page.screenshot({path:path.join(out,mode+'-failure.png')});throw error;}finally{await context.close();await server.close();}
}}finally{await browser.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
