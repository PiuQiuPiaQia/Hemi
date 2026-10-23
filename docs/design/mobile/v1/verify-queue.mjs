import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer,preview} from 'vite';
import {chromium} from 'playwright-core';

const root=import.meta.dirname,repo=path.resolve(root,'../../../..');
const output=path.join(repo,'.visual/workflow/mobile-queue-fix');
await fs.mkdir(output,{recursive:true});
const report={date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,sources:{},modes:[]};
for(const name of ['main.jsx','style.css','data.js','session.js','verify-queue.mjs'])report.sources[name]=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
const browser=await chromium.launch({executablePath:process.env.HEMI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 for(const mode of ['dev','built']){
  const options={configFile:path.join(root,'vite.config.mjs'),logLevel:'error'};
  const server=mode==='dev'?await createServer({...options,server:{host:'127.0.0.1',port:0}}):await preview({...options,preview:{host:'127.0.0.1',port:0}});
  let context;
  const result={mode,checks:[],errors:[],external:[],screenshots:[]};report.modes.push(result);
  try{
   if(mode==='dev')await server.listen();
   const url=server.resolvedUrls.local[0];result.url=url;
   context=await browser.newContext({viewport:{width:1440,height:1040},reducedMotion:'reduce',hasTouch:true,isMobile:true});
   const page=await context.newPage(),device=page.locator('.device');
   page.on('pageerror',error=>result.errors.push(error.message));
   page.on('console',message=>{if(message.type()==='error')result.errors.push(message.text());});
   page.on('request',request=>{if(!['data:','blob:'].includes(new URL(request.url()).protocol)&&new URL(request.url()).origin!==new URL(url).origin)result.external.push(request.url());});
   const check=text=>{result.checks.push(text);console.log('PASS',mode,text);};
   const go=async scene=>{await page.goto(url+'?scene='+scene);await device.locator('.mobile-composer').waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
   const shot=async(name,locator=device)=>{const file=path.join(output,`${mode}-${name}.png`);await locator.screenshot({path:file});result.screenshots.push(file);};
   const layout=async()=>{
    const geometry=await device.evaluate(el=>{
     const bounds=node=>node?.getBoundingClientRect().toJSON();
     const head=el.querySelector('.h24-queue-head'),composer=el.querySelector('.mobile-composer'),surface=el.querySelector('.composer-surface');
     return{screen:bounds(el.querySelector('.device-screen')),flow:bounds(el.querySelector('.conversation-frame')),surface:bounds(surface),region:bounds(el.querySelector('.queue-region')),composer:bounds(composer),head:bounds(head),headVisible:head?document.elementFromPoint(head.getBoundingClientRect().x+20,head.getBoundingClientRect().y+20)?.closest('.h24-queue-head')===head:true,shared:surface.contains(head)&&surface.contains(composer),overflow:document.documentElement.scrollWidth>innerWidth,rows:[...el.querySelectorAll('.h24-queue-item')].map(bounds),tools:[...el.querySelectorAll('.h24-queue-tool:not(.h24-queue-drag)')].map(bounds)};
    });
    assert.equal(geometry.overflow,false);assert.equal(geometry.shared,true);assert.equal(geometry.headVisible,true);
    assert.ok(Math.abs(geometry.region.bottom-geometry.composer.top)<1,'queue adjoins draft without a second card gap');
    assert.ok(geometry.composer.bottom<=geometry.screen.bottom&&geometry.surface.left>=geometry.screen.left&&geometry.surface.right<=geometry.screen.right);
    assert.ok(geometry.flow.height>=64,'reading area remains available');
    for(const tool of geometry.tools)assert.ok(tool.width>=43.9&&tool.height>=43.9,'44px controls remain tappable');
    return geometry;
   };

   for(const width of [320,375,390,768,1440]){
    await page.setViewportSize({width,height:width>680?1040:812});await go('queued');
    const geometry=await layout();assert.equal(geometry.rows.length,2);
    for(const row of geometry.rows)assert.ok(Math.abs(row.height-44)<.1,'single-line queue row is 44px');
    await shot(`queued-${width}`);
   }
   check('one composer surface, compact 44px rows/controls and no overflow at 320/375/390/768/1440 with coarse pointer');

   await page.setViewportSize({width:390,height:812});await go('queued');
   const input=device.getByRole('textbox',{name:'消息',exact:true});await input.fill('把发布说明发给我。');
   assert.equal(await device.locator('.h24-queue-text').first().evaluate(el=>getComputedStyle(el).fontSize),'13px');
   assert.equal(await input.evaluate(el=>getComputedStyle(el).fontSize),'16px');
   const head=device.locator('.h24-queue-head');await head.click();assert.equal(await head.getAttribute('aria-expanded'),'false');assert.equal(await device.locator('.h24-queue-item').count(),0);assert.equal(await input.inputValue(),'把发布说明发给我。');
   await shot('collapsed');await head.click();assert.equal(await device.locator('.h24-queue-item').count(),2);
   await page.emulateMedia({colorScheme:'dark'});assert.equal(await page.locator('.device-screen').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');await shot('dark-preference');await page.emulateMedia({colorScheme:'light'});
   check('13px queue / 16px input, collapse preserves draft/items; declared light appearance under dark preference');

   const longText='补充这份发布前检查清单：确认数据库迁移、回滚步骤、客户端兼容性和错误监控。'.repeat(6)+'https://example.invalid/'+('long-path-'.repeat(20));
   await device.getByRole('button',{name:'编辑这条',exact:true}).first().click();await device.getByRole('textbox',{name:'待发送内容',exact:true}).fill(longText);await device.getByRole('button',{name:'保存修改',exact:true}).click();
   await device.locator('.h24-queue-text').filter({hasText:longText}).waitFor();
   assert.ok(await device.locator('.h24-queue-text').first().evaluate(el=>el.scrollHeight>el.clientHeight&&el.clientHeight<=42));await layout();await shot('long-text');
   await device.getByRole('button',{name:'编辑这条',exact:true}).first().click();assert.equal(await device.getByRole('textbox',{name:'待发送内容',exact:true}).inputValue(),longText);await page.keyboard.press('Escape');
   check('long text and unbroken URL stay within two-line preview; editing retains the complete content');

   await go('queued');
   for(let index=0;index<5;index++){await input.fill(`补充排队内容 ${index+1}`);await device.getByRole('button',{name:'加入待发送',exact:true}).click();await page.waitForFunction(count=>document.querySelectorAll('.h24-queue-item').length===count,index+3);}
   await layout();
   const list=device.locator('.h24-queue-list');assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight));await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
   await device.getByRole('button',{name:'撤回这条',exact:true}).last().click();assert.equal(await device.locator('.h24-queue-item').count(),6);await layout();await shot('scrolling');
   check('many queued messages scroll inside the list; header/input stay visible and final item can be withdrawn');

   await page.setViewportSize({width:375,height:480});await go('queued');await layout();await device.getByRole('button',{name:'停止任务',exact:true}).click();await device.getByRole('button',{name:'继续发送',exact:true}).waitFor();await layout();
   assert.ok(await device.getByRole('button',{name:'继续发送',exact:true}).evaluate(el=>{const box=el.getBoundingClientRect(),body=el.closest('.h24-queue-body').getBoundingClientRect();return box.bottom<=body.bottom&&box.height>=44;}));await shot('short-paused');
   await device.locator('.h24-queue-list').evaluate(el=>{el.scrollTop=el.scrollHeight;});await device.getByRole('button',{name:'撤回这条',exact:true}).last().click();await device.getByRole('button',{name:'继续发送',exact:true}).click();await device.locator('.h24-user-bubble').filter({hasText:'再补充一份发布检查清单。'}).waitFor();assert.equal(await device.locator('.h24-user-bubble').filter({hasText:'再补充一份发布检查清单。'}).count(),1);
   check('375×480 pause/resume and list scrolling remain usable; explicit resume sends the remaining item once');

   await page.setViewportSize({width:375,height:812});await go('offline');await input.fill('离线保留的补充说明');await device.getByRole('button',{name:'加入待发送',exact:true}).click();await device.getByText('保存在这台手机，尚未发送到 Bot。',{exact:true}).waitFor();
   assert.equal(await device.getByRole('button',{name:'停止任务',exact:true}).isDisabled(),true);await shot('offline');
   await device.getByRole('button',{name:'重新连接',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.connection-banner'));await page.waitForFunction(()=>document.querySelectorAll('.h24-queue-item').length===1);
   await page.setViewportSize({width:1440,height:1040});await page.getByRole('button',{name:'完成当前演示任务',exact:true}).click();await device.locator('.h24-user-bubble').filter({hasText:'离线保留的补充说明'}).waitFor();assert.equal(await device.locator('.h24-user-bubble').filter({hasText:'离线保留的补充说明'}).count(),1);
   check('offline local queue note remains visible and reconnect dispatches once');

   await go('queued');await device.getByRole('button',{name:'撤回这条',exact:true}).last().click();await device.getByRole('button',{name:'撤回这条',exact:true}).last().click();assert.equal(await device.locator('.h24-queue-tray').count(),0);assert.equal(await device.locator('.queue-region').evaluate(el=>el.getBoundingClientRect().height),0);await shot('empty');
   check('withdrawing all items removes the queue without an empty border or extra gap');

   if(mode==='built'){
    for(const scene of ['conversation','running','queued','offline','unknown']){await go(scene);if(scene==='queued')await input.fill('把发布说明发给我。');await device.screenshot({path:path.join(root,'exports',scene+'.png')});}
    await go('conversation');await page.screenshot({path:path.join(root,'exports','overview.png')});
   }
   assert.deepEqual(result.errors,[]);assert.deepEqual(result.external,[]);check('no runtime/console errors or external requests');
  }finally{await context?.close();await server.close();}
 }
}finally{await browser.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
