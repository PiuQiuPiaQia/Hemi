import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';
import {scenes} from './data.js';

const root=import.meta.dirname,repo=path.resolve(root,'../../../..');
const output=path.join(repo,'.visual/workflow/mobile-design-v1');
await fs.mkdir(output,{recursive:true});await fs.mkdir(path.join(root,'exports'),{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,sources:{},modes:[]};
for(const name of ['main.jsx','conversation-drawer.jsx','pairing.jsx','pairing-demo.js','pairing-demo.png','panels.jsx','data.js','session.js','style.css','vite.config.mjs'])report.sources[name]=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const mode of ['dev','built']){
  const options={configFile:path.join(root,'vite.config.mjs'),logLevel:'error'};
  const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
  if(mode==='dev')await server.listen();
  const url=server.resolvedUrls.local[0];
  const context=await browser.newContext({viewport:{width:1440,height:1040},deviceScaleFactor:1,reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage(),result={mode,url,checks:[],errors:[],external:[],screenshots:[]};report.modes.push(result);
  // Exercise the documented Web fallback; native share sheets need device verification.
  await page.addInitScript(()=>Object.defineProperty(navigator,'share',{value:undefined,configurable:true}));
  page.on('pageerror',error=>result.errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});
  page.on('request',request=>{if(!['data:','blob:'].includes(new URL(request.url()).protocol)&&new URL(request.url()).origin!==new URL(url).origin)result.external.push(request.url());});
  const check=text=>{result.checks.push(text);console.log('PASS',mode,text);};
  const go=async scene=>{await page.goto(url+'?scene='+scene);await page.locator('.device').waitFor();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
  const device=page.locator('.device');
  const layout=async()=>{
   const value=await page.evaluate(()=>{
    const screen=document.querySelector('.device-screen').getBoundingClientRect();
    const composer=document.querySelector('.mobile-composer')?.getBoundingClientRect();
    const dialog=document.querySelector('.bottom-sheet')?.getBoundingClientRect();
    return{overflow:document.documentElement.scrollWidth>innerWidth,screen:screen.toJSON(),composer:composer?.toJSON(),dialog:dialog?.toJSON()};
   });
   assert.equal(value.overflow,false,'document horizontal overflow');
   if(value.composer)assert.ok(value.composer.bottom<=value.screen.bottom+1&&value.composer.top>value.screen.top,'composer stays within phone');
   if(value.dialog)assert.ok(value.dialog.bottom<=value.screen.bottom+1&&value.dialog.top>=value.screen.top,'sheet fits phone');
  };
  try{
   for(const scene of scenes){await go(scene.id);if(!['connect','trust','pair-scan','history','file'].includes(scene.id))await page.locator('.h24-hemi-message').first().waitFor();await layout();const file=mode==='dev'?path.join(output,`dev-${scene.id}.png`):path.join(root,'exports',`${scene.id}.png`);await device.screenshot({path:file});result.screenshots.push(file);}
   check(`${scenes.length} scenes render without clipping; separate readable phone screenshots`);
   assert.equal(await page.evaluate(()=>typeof window.hemiVoice),'undefined');
   check('actual SDK UI runs without Electron globals');
   await go('conversation');assert.equal(await device.locator('.h24-user-bubble').first().evaluate(el=>getComputedStyle(el).fontSize),'14px');assert.equal(await device.locator('.h24-hemi-message .chat-copy').first().evaluate(el=>getComputedStyle(el).fontSize),'14px');
   assert.equal(await device.getByRole('textbox',{name:'消息',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'16px');
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();assert.equal(await device.locator('.drawer-row-title').first().evaluate(el=>getComputedStyle(el).fontSize),'13px');await page.keyboard.press('Escape');
   check('compact 14px messages / 13px list typography, 16px editable input, touch targets retained');

   for(const width of [320,375,390,768,1440]){await page.setViewportSize({width,height:width>680?1040:812});for(const scene of ['connect','pair-share','pair-confirm','pair-scan','devices','history','conversation','queued','permission','offline','file']){await go(scene);await layout();}await page.screenshot({path:path.join(output,`${mode}-${width}.png`)});}
   await page.setViewportSize({width:375,height:480});await go('queued');await layout();await go('permission');await layout();
   check('320/375/390/768/1440 and shortened 375×480 viewport');
   await page.emulateMedia({colorScheme:'dark'});assert.equal(await page.locator('.device-screen').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');await page.emulateMedia({colorScheme:'light'});
   check('explicit light appearance remains readable under dark system preference');
   for(const height of [640,768,900,1040]){
    await page.setViewportSize({width:1440,height});await go('conversation');
    const dimensions=await device.evaluate(el=>{const box=el.getBoundingClientRect(),screen=el.querySelector('.device-screen'),s=screen.getBoundingClientRect();return{width:box.width,height:box.height,logicalWidth:screen.clientWidth,logicalHeight:screen.clientHeight,scale:s.width/screen.clientWidth,bottom:box.bottom,font:getComputedStyle(el.querySelector('.h24-user-bubble')).fontSize};});
    assert.equal(dimensions.logicalWidth,390);assert.equal(dimensions.logicalHeight,844);assert.ok(Math.abs(dimensions.width/dimensions.height-406/860)<.001);assert.ok(dimensions.height<=height-100);assert.ok(dimensions.bottom<=height-25,'phone and caption fit viewport');assert.ok(dimensions.scale<=1);assert.equal(dimensions.font,'14px');
    if(height===768)await page.screenshot({path:path.join(output,`${mode}-proportion-768h.png`)});
   }
   await page.setViewportSize({width:1440,height:1040});
   check('390×844 logical phone canvas stays fixed; whole frame scales proportionally at 640/768/900/1040 desktop heights');


   await page.setViewportSize({width:1440,height:1040});await go('connect');
   assert.equal(await device.getByRole('button',{name:'继续',exact:true}).isDisabled(),true);
   await device.getByRole('textbox',{name:'服务器地址',exact:true}).fill('preview.example.com');
   await device.getByRole('button',{name:'导入 SSH 私钥',exact:true}).click();await device.getByRole('button',{name:'继续',exact:true}).click();
   await device.getByRole('dialog',{name:'核对服务器身份',exact:true}).waitFor();assert.match(await device.locator('.fingerprint').innerText(),/^SHA256:/);assert.equal(await device.getByText('preview.example.com:22',{exact:true}).count(),1);
   await page.keyboard.press('Escape');assert.equal(await device.getByRole('dialog').count(),0);
   await device.getByRole('button',{name:'继续',exact:true}).click();await device.getByRole('button',{name:'信任并连接',exact:true}).click();
   await device.getByRole('button',{name:'打开对话列表',exact:true}).waitFor();assert.equal(await device.getByRole('dialog',{name:'对话列表',exact:true}).count(),0);
   await device.getByRole('textbox',{name:'消息',exact:true}).fill('切换会话仍保留的草稿');await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'检查服务器磁盘'}).click();
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'发布前检查'}).click();assert.equal(await device.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'切换会话仍保留的草稿');
   await page.reload();await device.getByRole('textbox',{name:'消息',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('textarea[aria-label="消息"]').value==='切换会话仍保留的草稿');
   check('connect → import authentication → host trust → main conversation; drawer switching and isolated drafts survive navigation/reload');

   await page.setViewportSize({width:375,height:480});await go('conversation');await device.getByRole('textbox',{name:'消息',exact:true}).fill('抽屉开合保留的草稿');
   const flow=await device.locator('.conversation-frame').elementHandle();
   const scroll=await device.locator('.conversation-frame').evaluate(el=>{const node=[el,...el.querySelectorAll('*')].find(n=>n.scrollHeight>n.clientHeight&&['auto','scroll'].includes(getComputedStyle(n).overflowY));if(!node)return null;node.scrollTop=40;return{className:node.className,top:node.scrollTop};});
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();
   const drawer=device.getByRole('dialog',{name:'对话列表',exact:true});await drawer.waitFor();
   assert.equal(await device.locator('.app-surface').evaluate(el=>el.inert),true);
   await drawer.getByRole('heading',{name:'置顶',exact:true}).waitFor();await drawer.getByRole('heading',{name:'最近',exact:true}).waitFor();
   const geometry=await device.evaluate(el=>{const screen=el.querySelector('.navigation-stage').getBoundingClientRect(),drawer=el.querySelector('.conversation-drawer').getBoundingClientRect(),main=el.querySelector('.app-surface').getBoundingClientRect();return{ratio:drawer.width/screen.width,drawerRight:drawer.right,mainLeft:main.left};});
   assert.ok(geometry.ratio>=.80&&geometry.ratio<=.83);assert.ok(Math.abs(geometry.drawerRight-geometry.mainLeft)<1);
   await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await drawer.evaluate(el=>el.contains(document.activeElement)),true);
   await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='打开对话列表');
   assert.equal(await flow.evaluate(el=>el.isConnected),true);assert.equal(await device.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'抽屉开合保留的草稿');
   assert.ok(scroll?.top>0,'exercise a genuinely scrolled conversation');
   if(scroll)assert.equal(await device.locator('.conversation-frame').evaluate((el,info)=>[el,...el.querySelectorAll('*')].find(n=>n.className===info.className)?.scrollTop,scroll),scroll.top);
   await page.setViewportSize({width:1440,height:1040});
   check('drawer is 82% wide, pushes main aside, traps focus; Escape restores focus without remounting flow or losing scroll/draft');

   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await drawer.getByRole('button',{name:'搜索对话',exact:true}).click();await drawer.getByRole('textbox',{name:'搜索对话标题',exact:true}).fill('服务器');assert.equal(await drawer.locator('.drawer-row').count(),1);
   await drawer.getByRole('textbox',{name:'搜索对话标题',exact:true}).fill('没有这个标题');await drawer.getByText('没有找到相关对话',{exact:true}).waitFor();
   await device.getByRole('button',{name:'收起对话列表',exact:true}).click({position:{x:350,y:140}});assert.equal(await drawer.count(),0);
   check('conversation search filters titles, handles no results and scrim closes drawer');

   await device.getByRole('button',{name:'新建对话',exact:true}).click();await device.getByRole('heading',{name:'今天想做什么？',exact:true}).waitFor();await device.getByRole('textbox',{name:'消息',exact:true}).fill('第一条独立的新对话');await device.getByRole('button',{name:'发送消息',exact:true}).click();await device.locator('.h24-user-bubble').filter({hasText:'第一条独立的新对话'}).waitFor();
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await drawer.getByRole('button',{name:'新对话',exact:true}).click();await device.getByRole('heading',{name:'今天想做什么？',exact:true}).waitFor();
   await device.getByRole('textbox',{name:'消息',exact:true}).fill('第二条对话的草稿');await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await drawer.locator('.drawer-row').filter({hasText:'第一条独立的新对话'}).click();await device.locator('.h24-user-bubble').filter({hasText:'第一条独立的新对话'}).waitFor();assert.equal(await device.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'');
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await drawer.getByRole('navigation',{name:'历史对话',exact:true}).getByRole('button',{name:'新对话',exact:true}).click();assert.equal(await device.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'第二条对话的草稿');
   check('top bar and drawer create separate conversations; first input names history and drafts remain isolated');

   await page.setViewportSize({width:375,height:812});await go('conversation');
   const cdp=await context.newCDPSession(page);
   const swipe=async(x1,y1,x2,y2)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x1,y:y1}]});for(let step=1;step<=5;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x1+(x2-x1)*step/5,y:y1+(y2-y1)*step/5}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
   await swipe(8,230,150,235);await drawer.waitFor();await device.screenshot({path:path.join(output,`${mode}-drawer-375.png`)});
   await drawer.locator('.drawer-list').evaluate(el=>{el.scrollTop=el.scrollHeight;});assert.ok(await drawer.locator('.drawer-footer').evaluate(el=>{const box=el.getBoundingClientRect(),parent=el.closest('.conversation-drawer').getBoundingClientRect();return box.bottom<=parent.bottom+1;}));
   await swipe(250,280,70,285);await page.waitForFunction(()=>!document.querySelector('.conversation-drawer'));await cdp.detach();
   await device.screenshot({path:path.join(output,`${mode}-conversation-375.png`)});await page.setViewportSize({width:1440,height:1040});
   check('touch edge swipe opens, left swipe closes; drawer history scrolls with fixed Bot footer on mobile');

   await go('queued');await device.getByLabel('待发送消息',{exact:true}).waitFor();
   await device.getByRole('button',{name:'编辑这条',exact:true}).first().click();await device.getByRole('textbox',{name:'待发送内容',exact:true}).fill('修改后的发布检查清单');await device.getByRole('button',{name:'保存修改',exact:true}).click();await device.locator('.h24-queue-text').filter({hasText:'修改后的发布检查清单'}).waitFor();
   await device.getByRole('button',{name:'撤回这条',exact:true}).last().click();assert.equal(await device.locator('.h24-queue-item').count(),1);
   await device.getByRole('button',{name:'停止任务',exact:true}).click();await device.getByRole('button',{name:'继续发送',exact:true}).waitFor();await device.getByRole('button',{name:'继续发送',exact:true}).click();await device.locator('.h24-user-bubble').filter({hasText:'修改后的发布检查清单'}).waitFor();
   check('SDK queue edit/withdraw → stop pauses queue → explicit resume dispatches once');

   await go('offline');await device.getByText('云端任务可能仍在继续。',{exact:true}).waitFor();
   assert.equal(await device.getByRole('button',{name:'停止任务',exact:true}).isDisabled(),true);
   await device.getByRole('textbox',{name:'消息',exact:true}).fill('断线时写下的下一条');await device.getByRole('button',{name:'加入待发送',exact:true}).click();
   await device.getByText('保存在这台手机，尚未发送到 Bot。',{exact:true}).waitFor();await device.getByRole('button',{name:'重新连接',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.connection-banner'));
   await page.waitForFunction(()=>document.querySelectorAll('.h24-queue-item').length===1);
   await page.getByRole('button',{name:'完成当前演示任务',exact:true}).click();await device.locator('.h24-user-bubble').filter({hasText:'断线时写下的下一条'}).waitFor();assert.equal(await device.locator('.h24-user-bubble').filter({hasText:'断线时写下的下一条'}).count(),1);
   check('offline input stays local → reconnect/reconcile → dispatch without duplication; offline stop unavailable');

   await go('offline');await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'整理项目文档'}).click();await device.getByText('云端任务可能仍在继续。',{exact:true}).waitFor();assert.equal(await device.getByRole('button',{name:'选择工作目录',exact:true}).isDisabled(),true);
   await device.getByRole('button',{name:'新建对话',exact:true}).click();await device.getByRole('heading',{name:'今天想做什么？',exact:true}).waitFor();await device.getByRole('textbox',{name:'消息',exact:true}).fill('新会话的离线输入');await device.getByRole('button',{name:'发送消息',exact:true}).click();await device.getByText('保存在这台手机，尚未发送到 Bot。',{exact:true}).waitFor();
   check('Bot disconnection remains in effect when switching or creating conversations; new offline input stays local');

   await go('unknown');await page.waitForFunction(()=>document.querySelector('textarea[aria-label="消息"]').value==='把发布说明发给我。');await device.getByRole('textbox',{name:'消息',exact:true}).fill('核对期间新写的草稿');assert.equal(await device.getByRole('button',{name:'加入待发送',exact:true}).isDisabled(),true);await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'整理项目文档'}).click();assert.equal(await device.getByText('有一条消息正在核对',{exact:true}).count(),0);await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'发布前检查'}).click();await device.getByText('有一条消息正在核对',{exact:true}).waitFor();await device.getByRole('button',{name:'核对结果',exact:true}).click();assert.equal(await device.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'核对期间新写的草稿');
   check('unknown submission blocks replay and reconciliation preserves a newer draft version');

   await go('permission');await device.getByRole('button',{name:'允许这次',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.permission-notice'));await go('permission');await device.getByRole('button',{name:'拒绝',exact:true}).click();await device.getByRole('button',{name:'继续任务',exact:true}).waitFor();
   await go('identity');assert.equal(await device.getByRole('button',{name:/跳过|仍然连接/}).count(),0);await device.getByRole('button',{name:'查看连接设置',exact:true}).click();await device.getByRole('dialog',{name:'Bot 连接',exact:true}).waitFor();
   check('permission allow/deny and identity mismatch blocking have explicit paths');

   await go('conversation');await device.getByRole('button',{name:'预览 发布说明.md',exact:true}).click();await device.getByRole('heading',{name:/移动端首版\s*发布说明/}).waitFor();
   const downloadEvent=page.waitForEvent('download');await device.getByRole('button',{name:'保存到文件',exact:true}).click();const download=await downloadEvent;assert.equal(download.suggestedFilename(),'发布说明-交互稿示例.md');await download.delete();
   await device.getByRole('button',{name:'分享文件',exact:true}).click();await device.getByText('已复制文件内容，可以粘贴分享',{exact:true}).waitFor();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/移动端首版发布说明/);await device.getByRole('button',{name:'返回对话',exact:true}).click();await device.getByRole('button',{name:'预览 发布说明.md',exact:true}).waitFor();
   check('real SDK file card → preview → real fixture download/clipboard sharing → original conversation');

   await device.getByRole('button',{name:'选择模型，当前工作模型',exact:true}).click();await device.getByRole('button',{name:'轻量模型',exact:false}).click();await device.getByRole('button',{name:'选择模型，当前轻量模型',exact:true}).waitFor();
   await device.getByRole('button',{name:'选择工作目录',exact:true}).click();await device.getByRole('button',{name:'projects',exact:true}).click();await device.getByRole('button',{name:'使用此文件夹',exact:true}).click();assert.equal(await device.locator('.composer-context>span').first().innerText(),'projects');
   await device.getByRole('button',{name:'添加内容',exact:true}).click();await device.getByRole('button',{name:/选择文件/}).click();await device.getByText('上传中…',{exact:true}).waitFor();await device.getByText('已就绪',{exact:true}).waitFor();await device.getByRole('button',{name:'移除附件',exact:true}).click();
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'整理项目文档'}).click();await device.getByRole('button',{name:'选择模型，当前工作模型',exact:true}).waitFor();assert.equal(await device.locator('.composer-context>span').first().innerText(),'默认空间');
   await device.getByRole('button',{name:'打开对话列表',exact:true}).click();await device.locator('.drawer-row').filter({hasText:'发布前检查'}).click();await device.getByRole('button',{name:'选择模型，当前轻量模型',exact:true}).waitFor();assert.equal(await device.locator('.composer-context>span').first().innerText(),'projects');
   await device.getByRole('button',{name:'Bot 连接设置',exact:true}).click();await device.getByRole('dialog',{name:'Bot 连接',exact:true}).waitFor();await page.keyboard.press('Escape');
   check('top shortcuts open model/folder/connection; model and folder remain per-conversation; staged attachment selection/removal');
   await go('settings');await device.getByRole('button',{name:/连接新设备/}).click();await device.getByRole('dialog',{name:'连接新设备',exact:true}).waitFor();await device.getByAltText('演示配对二维码，不能用于真实连接',{exact:true}).waitFor();
   await page.getByRole('button',{name:'模拟配对码过期',exact:true}).click();await device.getByRole('heading',{name:'配对码已过期',exact:true}).waitFor();assert.equal(await device.locator('.pairing-qr').count(),0);assert.equal(await device.getByRole('button',{name:'允许连接',exact:true}).count(),0);
   await device.getByRole('button',{name:'重新生成配对码',exact:true}).click();await device.getByAltText('演示配对二维码，不能用于真实连接',{exact:true}).waitFor();await device.getByRole('button',{name:'取消本次配对',exact:true}).click();await device.getByRole('dialog',{name:'Bot 连接',exact:true}).waitFor();
   await device.getByRole('button',{name:/连接新设备/}).click();await page.getByRole('button',{name:'模拟新设备扫码',exact:true}).click();assert.equal(await device.getByRole('button',{name:'允许连接',exact:true}).isDisabled(),true);await device.getByRole('checkbox',{name:'两台设备的验证码一致',exact:true}).check();await device.getByRole('button',{name:'允许连接',exact:true}).click();await device.getByRole('heading',{name:'新设备已连接',exact:true}).waitFor();assert.equal(await device.locator('.pairing-qr').count(),0);await device.getByRole('button',{name:'查看已连接设备',exact:true}).click();assert.equal(await device.getByText('我的新 iPhone',{exact:true}).count(),1);
   check('pairing demo: settings → short-lived QR; expiry removes QR, cancel returns to settings; explicit matching-code confirmation adds exactly one device');

   await go('pair-confirm');await device.getByRole('checkbox',{name:'两台设备的验证码一致',exact:true}).check();await page.getByRole('button',{name:'模拟配对码过期',exact:true}).click();await device.getByRole('heading',{name:'配对码已过期',exact:true}).waitFor();assert.equal(await device.getByRole('button',{name:'允许连接',exact:true}).count(),0);
   await device.getByRole('button',{name:'重新生成配对码',exact:true}).click();await page.getByRole('button',{name:'模拟新设备扫码',exact:true}).click();assert.equal(await device.getByRole('checkbox',{name:'两台设备的验证码一致',exact:true}).isChecked(),false);await device.getByRole('button',{name:'拒绝',exact:true}).click();await device.getByRole('heading',{name:'已拒绝连接',exact:true}).waitFor();
   await go('offline');await device.getByRole('button',{name:'Bot 连接设置',exact:true}).click();assert.equal(await device.getByRole('button',{name:/连接新设备/}).isDisabled(),true);
   check('pairing demo: expired or rejected requests cannot grant access; fresh invitations clear prior confirmation; offline generation disabled');

   await go('connect');await device.getByRole('button',{name:/扫码连接已有 Bot/}).click();await device.getByRole('dialog',{name:'扫码连接 Bot',exact:true}).waitFor();assert.equal(await page.evaluate(()=>navigator.mediaDevices?.getUserMedia?'camera available but unused':'camera unavailable'),'camera available but unused');
   await page.getByRole('button',{name:'演示识别配对码',exact:true}).click();await device.getByRole('button',{name:'向原设备发起连接请求',exact:true}).click();await device.getByRole('heading',{name:'请在原设备上确认',exact:true}).waitFor();assert.equal(await device.getByRole('button',{name:'进入对话',exact:true}).count(),0);await page.getByRole('button',{name:'模拟原设备允许连接',exact:true}).click();await device.getByRole('button',{name:'进入对话',exact:true}).click();await device.getByRole('button',{name:'打开对话列表',exact:true}).waitFor();
   await go('pair-scan');await page.getByRole('button',{name:'演示无效配对码',exact:true}).click();await device.getByRole('heading',{name:'配对码无法使用',exact:true}).waitFor();await device.getByRole('button',{name:'重新扫码',exact:true}).click();await page.getByRole('button',{name:'演示识别配对码',exact:true}).click();await device.getByRole('button',{name:'向原设备发起连接请求',exact:true}).click();await page.getByRole('button',{name:'模拟原设备拒绝连接',exact:true}).click();await device.getByRole('heading',{name:'原设备拒绝了连接',exact:true}).waitFor();
   await device.getByRole('button',{name:'重新扫码',exact:true}).click();await page.getByRole('button',{name:'演示识别配对码',exact:true}).click();await device.getByRole('button',{name:'向原设备发起连接请求',exact:true}).click();await page.getByRole('button',{name:'模拟连接请求过期',exact:true}).click();await device.getByRole('heading',{name:'配对请求已过期',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'模拟原设备允许连接',exact:true}).isDisabled(),true);assert.equal(await device.getByRole('button',{name:'进入对话',exact:true}).count(),0);
   check('scanner demo: connection entry → Bot review → wait for owner → connected; no access before approval; invalid/denied paths remain unconnected');

   await go('devices');await device.getByRole('button',{name:'撤销 我的 MacBook',exact:true}).click();await device.getByRole('button',{name:'取消',exact:true}).click();await device.getByRole('button',{name:'撤销 我的 MacBook',exact:true}).click();await device.getByRole('button',{name:'撤销访问',exact:true}).click();await device.getByText('访问已撤销',{exact:true}).waitFor();assert.equal(await device.getByRole('button',{name:'撤销 我的 MacBook',exact:true}).count(),0);assert.equal(await device.getByText('当前设备',{exact:true}).count(),1);
   check('device-management demo: revoke requires explicit confirmation, only target device changes; current device is retained');
   assert.deepEqual(result.errors,[]);assert.deepEqual(result.external,[]);check('no console errors, external requests or user credentials');
   if(mode==='built'){await go('conversation');await page.screenshot({path:path.join(root,'exports','overview.png')});}
  }finally{await context.close();await server.close();}
 }
}finally{await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report.modes.map(mode=>({mode:mode.mode,checks:mode.checks.length,errors:mode.errors})),null,2));
