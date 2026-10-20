// 060 视觉压力复验：真实 Electron／模型，长队列、小窗口与长文本流。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runPresentation({ evalJs, send, ws, uiRows, evidenceDir, UD, checks }) {
  const stages = [], frames = [], layouts = [], errors = [];
  const framesDir = path.join(evidenceDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2));
  const stage = (name) => { stages.push({ name, at: Date.now() }); console.log(`[q060-presentation] ${name}`); write('progress.json', stages.at(-1)); };
  const wait = async (name, predicate, timeout = 45000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(60); }
    throw new Error(`presentation timeout: ${name}`);
  };
  let cid;
  const flow = async () => {
    cid ??= fs.readdirSync(path.join(UD, 'conversations')).filter((file) => file.endsWith('.json') && !file.startsWith('._'))
      .map((file) => JSON.parse(fs.readFileSync(path.join(UD, 'conversations', file), 'utf8'))).sort((a,b) => b.updatedAt-a.updatedAt)[0]?.id;
    return cid ? evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`) : null;
  };
  const shot = async (name) => { const frame = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(frame.data, 'base64')); };
  const type = async (text) => {
    await evalJs(`(() => { const ta = document.querySelector('.text-composer-input'); ta.focus(); ta.select(); })()`);
    await send('Input.insertText', { text });
    await wait('输入', () => evalJs(`document.querySelector('.text-composer-input')?.value === ${JSON.stringify(text)}`));
  };
  const submit = async (text, accepted = true) => {
    await type(text);
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    if (accepted) await wait('草稿已受理', () => evalJs(`document.querySelector('.text-composer-input')?.value === ''`), 8000);
  };
  const layout = async (name) => {
    await sleep(400);
    const info = await evalJs(`(() => {
      const rect = (selector) => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight}; };
      return {width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,input:rect('.text-composer'),list:rect('.h24-queue-list'),transcript:rect('[data-transcript-scroll]'),send:rect('.text-composer-send')};
    })()`);
    layouts.push({ name, ...info });
    checks[`${name}-输入可见`] = info.input.top >= 52 && info.send.bottom <= info.height && info.send.right <= info.width;
    checks[`${name}-保留对话可读空间`] = info.transcript.height >= Math.min(160, info.height * .25);
    checks[`${name}-队列独立滚动`] = info.list.clientHeight < info.list.scrollHeight;
    checks[`${name}-无横向溢出`] = info.pageWidth === info.width;
    await shot(name);
  };
  const receive = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params);
    if (message.method !== 'Page.screencastFrame') return;
    const {data,sessionId} = message.params;
    void send('Page.screencastFrameAck', {sessionId}).catch(() => {});
    const file = `frame-${String(frames.length).padStart(5,'0')}.jpg`;
    fs.writeFileSync(path.join(framesDir,file),Buffer.from(data,'base64')); frames.push({file,at:Date.now()});
  };
  ws.addEventListener('message',receive);
  await send('Page.enable'); await send('Page.bringToFront');
  await send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1440,maxHeight:900,everyNthFrame:2});
  try {
    stage('真实慢工具中连续排队8条并验证满额反馈');
    await submit('视觉压力060：只调用一次 bash 执行 sleep 60，结束后只回复完成。');
    await wait('真实工具在途',async () => (await flow())?.timeline.some((item) => item.parts?.some((p) => p.kind === 'tool' && p.status === 'running')));
    for(let i=1;i<=8;i++) await submit(`视觉队列${String(i).padStart(2,'0')}：请稍后整理这条消息，保留排队顺序。`);
    checks.queue8OnlyPending = (await flow()).pending.length === 8 && (await uiRows()).filter((r)=>r.kind==='user').length === 1;
    const overflowDraft = '视觉第9条：队列满时草稿必须保留。';
    await submit(overflowDraft, false);
    await sleep(300);
    checks.fullQueueKeepsDraft = (await flow()).pending.length === 8 && await evalJs(`document.querySelector('.text-composer-input')?.value === ${JSON.stringify(overflowDraft)}`);
    checks.fullQueueHelpfulMessage = await evalJs(`document.body.innerText.includes('待发送队列最多 8 条') && !document.body.innerText.includes('queue-full')`);
    await shot('00-queue-full-feedback');
    await layout('01-native-long-queue');
    await send('Emulation.setDeviceMetricsOverride',{width:768,height:540,deviceScaleFactor:1,mobile:false});
    await layout('02-small-height-queue');
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:667,deviceScaleFactor:1,mobile:false});
    await layout('03-narrow-queue');
    await send('Emulation.clearDeviceMetricsOverride'); await sleep(400);
    stage('长队列内滚动、指针排序与跨滚动区键盘排序');
    const scrollPoint = await evalJs(`(()=>{const r=document.querySelector('.h24-queue-list').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:0,deltaY:400});
    await sleep(400);
    checks.queueScrollReachLast = await evalJs(`(()=>{const list=document.querySelector('.h24-queue-list'),r=[...list.querySelectorAll('.h24-queue-item')].at(-1).getBoundingClientRect();return list.scrollTop>0 && r.bottom<=list.getBoundingClientRect().bottom+2;})()`);
    const points=await evalJs(`(()=>{const rows=[...document.querySelectorAll('.h24-queue-item')]; const r=rows[7].querySelector('.h24-queue-drag').getBoundingClientRect(),to=rows[6].getBoundingClientRect();return{x:r.x+r.width/2,from:r.y+r.height/2,to:to.y+to.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:points.x,y:points.from});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:points.x,y:points.from,button:'left',buttons:1,clickCount:1});
    for(let i=1;i<=5;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:points.x,y:points.from+(points.to-points.from)*i/5,buttons:1});await sleep(50);}
    await shot('03b-scroll-dragging');
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:points.x,y:points.to,button:'left',buttons:0,clickCount:1});
    await wait('滚动后指针排序',async()=>(await flow()).pending[6].text.startsWith('视觉队列08'));
    checks.pointerSortInScrolledQueue=true;
    await wait('排序回执后手柄可用',()=>evalJs(`![...document.querySelectorAll('.h24-queue-item')].find(row=>row.textContent.includes('视觉队列08')).querySelector('.h24-queue-drag').disabled`));
    const key=async(code,key,value)=>{for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,code,key,windowsVirtualKeyCode:value});};
    await key('Tab','Tab',9);
    await evalJs(`[...document.querySelectorAll('.h24-queue-item')].find(row=>row.textContent.includes('视觉队列08')).querySelector('.h24-queue-drag').focus()`);
    await wait('键盘提起前焦点',()=>evalJs(`document.activeElement?.classList.contains('h24-queue-drag')`),3000);
    await key('Space',' ',32);await sleep(150);
    for(let i=0;i<6;i++){await key('ArrowUp','ArrowUp',38);await sleep(200);}
    await key('Space',' ',32);
    await wait('键盘从滚动区底部排到队首',async()=>(await flow()).pending[0].text.startsWith('视觉队列08'));
    checks.keyboardSortAcrossScroll=true;
    await shot('03c-keyboard-to-head');
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:0,deltaY:400});
    await sleep(300);
    stage('停止并保留8条；逐条撤回');
    // 明确停止，避免压力样例逐条发模型；随后通过真实控件撤回测试队列。
    await evalJs(`document.querySelector('.text-composer-stop, .text-composer-send.is-stop')?.click()`);
    await wait('真实停止',async()=> {const f=await flow(); return f?.queuePaused && f.phase==='idle';});
    await sleep(200);
    checks.pausedResumeAlwaysVisible = await evalJs(`(()=>{const b=document.querySelector('.h24-queue-resume')?.getBoundingClientRect(),tray=document.querySelector('.h24-queue-tray')?.getBoundingClientRect();return b && b.top>=tray.top && b.bottom<=tray.bottom;})()`);
    await shot('03d-paused-at-scroll-bottom');
    for(let i=0;i<8;i++) {
      await evalJs(`document.querySelector('.h24-queue-item button[aria-label="撤回这条"]')?.click()`);
      await wait('撤回确认',async()=> (await flow()).pending.length===7-i);
    }
    await evalJs(`document.querySelector('.h24-queue-resume')?.click()`);
    await wait('队列恢复',async()=> !(await flow()).queuePaused);
    stage('真实长Markdown流式输出、上翻阅读与回到底部');
    await evalJs(`window.presentationProbe = {samples:[],pausedAt:null}; (()=>{const sample=()=>{const v=document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]'); window.presentationProbe.samples.push({at:Date.now(),top:v?.scrollTop,height:v?.clientHeight,content:v?.scrollHeight,unpinned:document.querySelector('.panel-jump')?.dataset.visible==='true',text:document.querySelector('.conversation-list')?.textContent.length,primary:document.querySelectorAll('.text-composer-send').length}); if(!window.presentationProbe.stopped)requestAnimationFrame(sample);};requestAnimationFrame(sample);})()`);
    await submit('视觉长文060：请直接写一份中文的周末出行准备清单，共24个编号小节。每节标题加粗，再写约80字连贯说明，包含具体建议。第12节用三列表格比较交通方式，最后以“视觉长文结束”收尾。不要使用工具，不要省略条目。');
    await wait('长回答超过一屏',()=>evalJs(`(() => {const v=document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');return v.scrollHeight>v.clientHeight+500;})()`));
    const point=await evalJs(`(()=>{const r=document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-300});
    await wait('暂停跟随',()=>evalJs(`document.querySelector('.panel-jump')?.dataset.visible==='true'`));
    const top=await evalJs(`document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]').scrollTop`);
    await sleep(1400);
    checks.streamReadingPositionKept=await evalJs(`Math.abs(document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]').scrollTop-${top})<2`);
    await shot('04-stream-reading');
    await evalJs(`document.querySelector('.panel-jump')?.click()`);
    await wait('长文真实收口',async()=> (await flow())?.phase==='idle',90000);
    await sleep(600); await shot('05-long-answer-done');
    checks.longAnswerComplete=(await uiRows()).some((row)=>row.kind==='assistant' && row.text.endsWith('视觉长文结束'));
    const probe=await evalJs(`window.presentationProbe.stopped=true; window.presentationProbe`);
    write('stream-probes.json',probe);
    checks.noDuplicatePrimary=probe.samples.every((s)=>s.primary===1);
    checks.noRendererException=errors.length===0;
    write('final-rows.json',await uiRows());
    stage('视觉压力复验结束');
  } catch(error) {
    await shot('failure').catch(()=>{}); write('failure.json',{message:error.message}); throw error;
  } finally {
    await send('Page.stopScreencast').catch(()=>{}); ws.removeEventListener('message',receive);
    await send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
    write('presentation-summary.json',{checks,layouts,stages,errors});write('screencast-frames.json',frames);
    fs.writeFileSync(path.join(framesDir,'frames.txt'),frames.map((frame,i)=>`file '${frame.file}'\nduration ${Math.max(.02,((frames[i+1]?.at??frame.at+1000)-frame.at)/1000).toFixed(3)}\n`).join(''));
  }
}
