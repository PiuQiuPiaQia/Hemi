/** 038 独立设计原型导出与交互检查；不启动 Hemi、不请求模型、不新增项目依赖。 */
import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const designDir = path.join(root,'requirements/038-auto-model-routing/designs/2026-10-04-auto-routing');
const evidenceDir = path.join(root,'.visual/workflow/vision/038-auto-routing');
const modulePath = process.env.HEMI_DESIGN_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const browser = await chromium.launch({headless:true,...(process.env.HEMI_DESIGN_BROWSER_PATH ? {executablePath:process.env.HEMI_DESIGN_BROWSER_PATH} : {})});
const base = (process.env.HEMI_DESIGN_BASE_URL || 'http://127.0.0.1:8768') + '/requirements/038-auto-model-routing/designs/2026-10-04-auto-routing/index.html';
const errors=[],checks=[],screenshots=[];
const note = name => checks.push({name,status:'pass'});
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const watch = page => {
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => {if(message.type()==='error') errors.push(message.text());});
  page.on('response',response => {if(response.status()>=400) errors.push(response.status()+' '+response.url());});
};
try {
  await mkdir(path.join(designDir,'exports'),{recursive:true});
  await mkdir(evidenceDir,{recursive:true});
  const css = await readFile(path.join(designDir,'styles.css'),'utf8');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css),false,'新增 CSS 不写硬编码 hex');
  assert.equal(/@media[^\{]*width:\s*(?!880|600)\d+px/.test(css),false,'不增加布局断点');
  note('新增样式复用 tokens，断点只用 880/600；无预览第三栏，1180 不需要新规则');

  const page = await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  watch(page);
  await page.goto(base+'?capture=1&scene=settings-empty');
  await page.locator('#role-chat').selectOption('aliyun/qwen-flash');
  await pause(700);
  await page.getByRole('button',{name:'返回对话'}).click();
  await page.locator('#model-trigger').click();
  assert.equal(await page.locator('[data-select="auto"]').isDisabled(),true);
  await page.locator('[data-menu-settings]').click();
  await page.locator('#role-execution').selectOption('deepseek/deepseek-chat');
  await pause(700);
  assert.equal(await page.locator('#role-fallback').inputValue(),'');
  await page.getByRole('button',{name:'返回对话'}).click();
  await page.locator('#model-trigger').click();
  await page.locator('[data-select="auto"]').click();
  assert.match(await page.locator('#model-trigger').innerText(),/自动/);
  assert.equal(await page.getByRole('button',{name:'思考强度：按模型设置'}).isDisabled(),true);
  note('首次逐项保存；未配齐不能选自动；配齐且无备用可选自动；思考只读');

  await page.locator('#model-trigger').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.select),'auto');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'model-trigger');
  await page.locator('#model-trigger').click();
  await page.locator('#model-search').fill('deepseek');
  assert.equal(await page.locator('[data-select]').count(),1);
  await page.keyboard.press('Escape');
  note('菜单方向键、Esc 焦点返回和搜索可用');

  await page.goto(base+'?capture=1&scene=settings-ready');
  await page.locator('#role-chat').selectOption('aliyun/qwen-plus');
  await page.locator('#role-execution').selectOption('anthropic/claude-sonnet-4-5');
  await pause(1400);
  assert.equal(await page.locator('#role-chat').inputValue(),'aliyun/qwen-plus');
  assert.equal(await page.locator('#role-execution').inputValue(),'anthropic/claude-sonnet-4-5');
  note('连续修改两个角色经串行模拟保存，不丢更新');

  await page.goto(base+'?capture=1&scene=settings-ready');
  await page.keyboard.press('Control+Shift+D');
  await page.locator('#fail-next-save').click();
  await page.locator('#role-execution').selectOption('anthropic/claude-sonnet-4-5');
  await pause(700);
  assert.equal(await page.locator('#role-execution').inputValue(),'deepseek/deepseek-chat');
  assert.match(await page.locator('.save-error').innerText(),/已保留原设置/);
  await page.locator('#role-chat').selectOption('aliyun/qwen-plus');
  await pause(700);
  assert.equal(await page.locator('.save-error').count(),1);
  await page.locator('[data-action="retry-save"]').click();
  await pause(700);
  assert.equal(await page.locator('#role-execution').inputValue(),'anthropic/claude-sonnet-4-5');
  assert.equal(await page.locator('.save-error').count(),0);
  note('保存失败回滚；其他角色成功不遮掉失败；原修改可重试');

  await page.goto(base+'?capture=1&scene=settings-ready');
  await page.locator('#role-fallback').selectOption('aliyun/qwen-plus');
  await pause(700);
  await page.getByRole('button',{name:'返回对话'}).click();
  await page.locator('#message').fill('整理本周项目资料');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  assert.equal(await page.locator('#message').inputValue(),'');
  await page.getByRole('button',{name:'打开模型设置'}).click();
  await page.locator('#role-fallback').selectOption('anthropic/claude-sonnet-4-5');
  await pause(700);
  await page.getByRole('button',{name:'返回对话'}).click();
  await page.keyboard.press('Control+Shift+D');
  await page.locator('#simulate-fault').click();
  assert.match(await page.locator('.routing-event').innerText(),/qwen-plus/);
  assert.equal(await page.locator('.routing-event').count(),1);
  assert.match(await page.locator('#model-trigger').innerText(),/自动/);
  await page.keyboard.press('Control+Shift+D');
  await page.locator('#simulate-fault').click();
  assert.equal(await page.locator('.routing-event').count(),1);
  note('在途配置修改不改任务演示快照；一次切换记录；chip 始终显示自动');

  await page.goto(base+'?capture=1&scene=settings-environment');
  assert.equal(await page.locator('select[id^="role-"]:disabled').count(),3);
  note('环境覆盖：三角色只读且原因可见');
  await page.goto(base+'?capture=1&scene=settings-invalid');
  assert.equal(await page.locator('#role-execution').getAttribute('aria-invalid'),'true');
  await page.goto(base+'?capture=1&scene=settings-credentials');
  assert.match(await page.locator('.h37-error-text').innerText(),/未配置 Key/);
  assert.match(await page.locator('[data-provider="DeepSeek"] .h37-badge').innerText(),/缺 Key/);
  note('失效引用与缺凭据明确指出角色并保留修复入口');

  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base+'?capture=1&scene=chat-picker');
  assert.equal(await page.locator('#model-menu').evaluate(el=>getComputedStyle(el).animationName),'none');
  note('减少动态效果时菜单动画关闭');
  await page.close();

  const primary = ['settings-ready','chat-picker','chat-auto'];
  const extra = ['settings-empty','settings-invalid','settings-credentials','settings-save-error','settings-environment','settings-vision','settings-long','chat-unconfigured','task-fallback'];
  for (const width of [1440,768,375]) {
    const height = width===1440 ? 1000 : 1100;
    const shotPage = await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
    watch(shotPage);
    for (const scene of [...primary,...(width===1440 ? extra : [])]) {
      await shotPage.goto(base+'?capture=1&scene='+scene);
      await pause(300);
      const metrics = await shotPage.evaluate(()=>({
        viewport:innerWidth,bodyWidth:document.body.scrollWidth,
        topbarHeight:document.querySelector('.topbar').getBoundingClientRect().height,
        sidebar:getComputedStyle(document.querySelector('.sidebar')).display,
        rail:getComputedStyle(document.querySelector('.rail')).display,
        menu:document.querySelector('#model-menu')?.getBoundingClientRect().toJSON(),
        autoLabelWidth:document.querySelector('.auto-chip .tool-label')?.getBoundingClientRect().width,
        roleCount:document.querySelectorAll('select[id^="role-"]').length,
      }));
      assert.equal(metrics.bodyWidth,width,'无页面横向溢出');
      assert.equal(metrics.topbarHeight,52,'顶栏遵循 52px');
      if (metrics.menu) {assert.ok(metrics.menu.left>=16-1 && metrics.menu.right<=width-16+1 && metrics.menu.top>=16-1 && metrics.menu.bottom<=height-16+1,'菜单不越界');}
      if (scene==='chat-auto') assert.ok(metrics.autoLabelWidth>0,'窄窗自动文字保留');
      if (scene==='settings-ready') assert.equal(metrics.roleCount,3);
      const filename=`${scene}-${width}.png`;
      await shotPage.screenshot({path:path.join(evidenceDir,filename)});
      await copyFile(path.join(evidenceDir,filename),path.join(designDir,'exports',filename));
      screenshots.push({scene,width,height,scale:1,filename,...metrics});
    }
    await shotPage.close();
  }
  note('18 张三档/状态图：无横向溢出，菜单边界、52px 顶栏、自动文字通过');
  assert.equal(errors.length,0,errors.join('\n'));
  note('console / pageerror / HTTP 错误均为 0');
  const report={date:'2026-10-04',scope:'独立设计原型；不代表产品路由验收',round:3,checks,screenshots,errors,pixelComparison:'新建 038 稿件基线；未做内容不同的 040 跨页比对。产品实现后按本基线固定 0.5% 校验。',darkMode:'040 当前没有深色视觉主题，本稿不新增主题。'};
  await writeFile(path.join(designDir,'exports','validation.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(path.join(evidenceDir,'validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:checks.length,screenshots:screenshots.length,errors:errors.length,browserClosed:true}));
} finally { await browser.close(); }
