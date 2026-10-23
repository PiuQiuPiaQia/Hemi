/* Interaction prototype only: no SSH, network model calls, real passwords or API keys.
 * All task output, host identities and validation results are synthetic fixtures. */
(() => {
  'use strict';
  const $ = (q) => document.querySelector(q);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => globalThis.botIcons[name] ?? '';
  const params = new URLSearchParams(location.search);
  document.body.classList.toggle('canvas', params.get('canvas') === '1');
  const scenes = [
    ['welcome','01 首次进入'],['connect','02 连接服务器'],['trust','03 首次指纹确认'],
    ['connect-error','04 连接失败'],['configure','05 配置 Bot'],['initializing','06 正在初始化'],
    ['init-error','07 初始化失败'],['init-canceled','初始化已取消'],['initialized','08 初始化完成'],['ready','09 Bot 待命'],
    ['running','10 云端执行'],['approval','11 等待授权'],['complete','12 结果与交付物'],
    ['offline','13 连接中断'],['unknown','14 受理状态待核对'],['stopped','15 Bot 已停止'],
    ['task-stopped','16 任务已停止'],['settings','17 Bot 设置'],['remove','18 移除连接'],['identity','19 身份冲突']
  ];
  const chatStates = new Set(['ready','running','approval','complete','offline','unknown','stopped','task-stopped']);
  let state = 'welcome', layer = null, lastBot = 'welcome', timer = null, taskTimer = null, initTimer = null, installStep = 2;
  let remoteState='ready', lastTaskState='complete', installed=false, reuseInstall=false;
  let initRunning=false, layerStack = [], editingModel = null, hasTask = false, offlineSnapshot = 'complete';
  let nextFailure = false, taskText = '检查项目最近的改动，整理成一份变更摘要。', draft = '', approvalResult = null;
  let modelMode = 'local', authMode = 'key', focusReturn = null, bound = false, statusMessage = '';
  const config = { host: '', workdir: '/home/ubuntu/hemi-workspace', model: 'deepseek-chat', endpoint: 'https://api.example.com/v1' };
  const installSteps = [
    ['检查运行环境','Linux、安装权限与常驻条件已就绪'],
    ['安装云端运行组件','独立安装，不修改系统 Node 环境'],
    ['配置模型与工作目录','仅保存所选模型配置和目录授权'],
    ['启动并验证常驻','断开 SSH 后重连，确认服务继续运行'],
    ['保存连接','下次进入直接打开这个 Bot']
  ];
  const app = $('#app');
  $('#scene-picker').innerHTML = scenes.map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
  $('#scene-picker').addEventListener('change', e => showScene(e.target.value));
  $('#reset-prototype').addEventListener('click', () => { reset(); showScene('welcome'); });
  function reset() { clearTimeout(timer); clearTimeout(taskTimer); clearTimeout(initTimer); initRunning=false; layerStack=[]; editingModel=null; hasTask=false; offlineSnapshot='complete'; remoteState='ready'; lastTaskState='complete'; installed=false;reuseInstall=false; config.host = ''; bound = false; draft = ''; layer = null; approvalResult = null; statusMessage = ''; modelMode = 'local'; authMode = 'key'; }
  function current() { return layer && ['trust','settings','remove'].includes(layer) ? layer : state; }
  function showScene(name, fixture = true) {
    clearTimeout(timer); clearTimeout(taskTimer); clearTimeout(initTimer); initRunning=false; layerStack=[]; editingModel=null; layer = null; statusMessage = ''; approvalResult = null; hasTask=!['welcome','ready','connect','trust','configure','initializing','init-error','init-canceled','initialized','connect-error'].includes(name); offlineSnapshot='complete';
    if (fixture && name !== 'welcome' && !config.host) config.host = 'ubuntu@hemi-cloud';
    if (name === 'trust') { state = 'connect'; layer = 'trust'; }
    else if (name === 'settings' || name === 'remove') { state = 'complete'; layer = name; bound = true; }
    else { state = name; }
    if (chatStates.has(state)) bound = true;
    if (state === 'initializing') installStep = 2;
    if (state === 'init-error') installStep = 3;
    if (state === 'init-canceled') installStep = 2;
    if (state === 'approval') taskText = '整理项目的变更摘要，并推送到仓库。';
    else if (state !== 'home') taskText = '检查项目最近的改动，整理成一份变更摘要。';
    if (state === 'offline') draft = '再检查一下有没有遗漏的文件';
    if (state === 'unknown') draft = '';
    if(chatStates.has(state)){remoteState=['offline'].includes(state)?'complete':state==='unknown'?'running':state;lastTaskState=state==='task-stopped'?'task-stopped':'complete';}
    installed=!['welcome','connect','connecting','connect-error','trust','configure','identity'].includes(state);reuseInstall=false;
    lastBot = state; render();
  }
  function go(next) { clearTimeout(timer); layer = null; layerStack=[]; state = next; if (next !== 'home') lastBot = next; render(); const heading=app.querySelector('.wizard h2,.welcome h1');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});} }
  function toast(message) { const el=$('#toast'); el.textContent=message; el.hidden=false; setTimeout(()=>{el.hidden=true;},2600); }
  const button = (text,action,kind='ghost',i='',attrs='') => `<button type="button" class="btn ${kind}" data-action="${action}" ${attrs}>${i ? icon(i) : ''}${text}</button>`;
  function topStatus() {
    if (['offline','unknown'].includes(state)) return ['连接已断开','',''];
    if (state === 'stopped') return ['已停止','',''];
    if (state === 'approval') return ['等待确认','waiting',''];
    if (state === 'running') return ['执行中','online',''];
    if (chatStates.has(state)) return ['已连接','online',''];
    if(state==='initialized')return ['已就绪','online',''];
    if (['configure','initializing','init-error','init-canceled'].includes(state)) return ['服务器已连接','online',''];
    if (state === 'connecting') return ['连接中','',''];
    return ['尚未连接','',''];
  }
  function render() {
    const prior=document.activeElement;
    const focusToken=prior?.id?'#'+CSS.escape(prior.id):prior?.name&&prior?.value?'input[name="'+prior.name+'"][value="'+CSS.escape(prior.value)+'"]':prior?.dataset.action?'[data-action="'+prior.dataset.action+'"]':null;
    const [status,statusClass]=topStatus();
    const initialized = chatStates.has(state) || state === 'home';
    const isHome = state === 'home';
    app.innerHTML = `
      <div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
      <header class="topbar">
        <div class="top-title"><strong>${isHome?'对话':initialized?'Hemi Bot':'Bot'}</strong>${initialized&&!isHome?`<span class="top-host" title="${esc(config.host)}">${icon('Server')}<span>${esc(config.host || 'ubuntu@hemi-cloud')}</span></span>`:''}</div>
        <div class="top-actions">${isHome?'':`<span class="status ${statusClass}" role="status"><i class="dot"></i>${status}</span>${initialized?button('','settings','ghost icon','Settings','id="bot-settings" aria-label="Bot 设置" title="Bot 设置"'):''}`}</div>
      </header>
      <nav class="rail" aria-label="应用导航">
        <button class="nav-btn" type="button" data-action="home" aria-label="对话" title="对话" ${isHome?'aria-current="page"':''}>${icon('MessageCircle')}</button>
        <button class="nav-btn" type="button" disabled aria-label="技能中心，当前原型不包含此页" title="技能中心（现有页面）">${icon('Sparkles')}</button>
        <button class="nav-btn" type="button" disabled aria-label="工作流，当前原型不包含此页" title="工作流（现有页面）">${icon('Workflow')}</button>
        <button class="nav-btn" type="button" data-action="bot" aria-label="Bot" title="Bot" ${!isHome?'aria-current="page"':''}>${icon('Bot')}</button>
        <div class="rail-space"></div>
        <button class="nav-btn" type="button" disabled aria-label="换肤，当前原型不包含此操作" title="沿用 Hemi 现有皮肤">${icon('Shirt')}</button>
        <button class="nav-btn" type="button" disabled aria-label="应用设置，当前原型不包含此页" title="应用设置（现有页面）">${icon('Settings')}</button>
      </nav>
      <main class="surface" aria-label="${isHome?'普通对话':'Bot'}">${page()}${layer ? overlay(layer) : ''}</main>`;
    $('#scene-picker').value = scenes.some(([key]) => key === current()) ? current() : lastBot;
    app.dataset.state = current();
    const url = new URL(location.href); url.searchParams.set('state',current()); history.replaceState(null,'',url);
    if (layer) {
      app.querySelectorAll('header,nav,.surface > :not(.modal-layer):not(.panel-layer)').forEach(el=>{el.inert=true;});
      const focusable=app.querySelector('[role="dialog"] button:not(:disabled),[role="dialog"] input:not(:disabled)');
      focusable?.focus({preventScroll:true});
    }
    if(focusToken){const matching=[...app.querySelectorAll(focusToken)].find(el=>!el.closest('[inert]')&&el.getClientRects().length);matching?.focus({preventScroll:true});}
  }
  function steps(n) {
    return `<div class="steps" aria-label="初始化步骤">${['连接服务器','配置 Bot','初始化'].map((label,i)=>`${i?'<span class="step-line" aria-hidden="true"></span>':''}<div class="step ${i<n?'done':i===n?'current':''}" ${i===n?'aria-current="step"':''}><i>${i<n?icon('Check'):i+1}</i><span>${label}</span></div>`).join('')}</div>`;
  }
  function wizard(n,body) { return `<div class="page-scroll"><section class="wizard fade-in">${steps(n)}${body}</section></div>`; }
  function page() {
    if (state === 'welcome') return `<div class="page-scroll center-stage"><section class="welcome fade-in"><div class="bot-emblem">${icon('Bot')}</div><h1>让 Hemi 在云端持续工作</h1><p>连接你的 Linux 服务器，初始化一个常驻 Bot。<br>关闭本机 Hemi 后，云端任务依然继续。</p>${button('创建连接','create','primary large','Plug','id="create-connection"')}<div class="welcome-note">${icon('LockKeyhole')}通过 SSH 安全连接</div><div class="welcome-caption"><span>${icon('Terminal')}云端文件与命令</span><span>${icon('Clock3')}离线继续执行</span></div></section></div>`;
    if (['connect','connecting','connect-error'].includes(state)) return connectPage();
    if (state === 'configure') return configurePage();
    if (['initializing','init-error','init-canceled'].includes(state)) return installPage();
    if (state === 'initialized') return wizard(3,`<div class="wizard-head"><div class="bot-emblem">${icon('CircleCheck')}</div><h2>云端 Bot 已准备就绪</h2><p>它会在服务器上持续待命。你可以随时回到这里，<br>交给它任务或查看执行结果。</p></div><div class="setup-summary"><div class="server-avatar">${icon('Server')}</div><div><strong>${esc(config.host)}</strong><small>Linux · 常驻运行 · 开机启动已配置</small></div></div><dl class="setting-grid" style="margin-top:var(--sp-20)"><dt>模型</dt><dd>${esc(config.model)}</dd><dt>工作目录</dt><dd><code>${esc(config.workdir)}</code></dd></dl><div class="wizard-footer">${button('开始使用','enter-bot','primary large','ArrowRight','id="enter-bot"')}</div>`);
    if (state === 'identity') return wizard(0,`<div class="wizard-head"><h2>服务器身份已变化</h2><p>这个地址返回的主机身份与已保存的记录不一致。<br>为避免连接到另一台机器，已暂停连接。</p></div><div class="inline-note warn">${icon('ShieldCheck')}<p>如果服务器刚刚重装或更换，请先核对 SSH 地址和主机指纹。原 Bot 的记录没有被覆盖。</p></div><details class="disclosure"><summary>查看身份差异</summary><pre>已保存：SHA256:hemiSavedExampleFingerprint\n当前返回：SHA256:hemiChangedExampleFingerprint\n两者不一致，未部署或执行任何命令。</pre></details><div class="wizard-footer">${button('返回 Bot','identity-back','ghost','ArrowLeft')}${button('检查连接信息','edit-connection','primary large')}</div>`);
    if (state === 'home') return `<div class="chat-empty"><h1>今天想做什么？</h1><p>这是普通对话页面的占位示意。</p>${button('返回云端 Bot','bot','secondary large','Bot')}</div>`;
    if (state === 'ready') return `<div class="chat-empty fade-in"><div class="bot-emblem">${icon('Bot')}</div><h1>云端 Bot 正在待命</h1><p>给它一个任务，工作会在服务器上完成。</p><div class="prompt-row"><button type="button" data-action="example" data-prompt="检查项目最近的改动，整理成一份变更摘要。">整理项目改动</button><button type="button" data-action="example" data-prompt="检查项目目录，告诉我从哪里开始。">了解工作目录</button></div></div>${composer()}`;
    return chatPage();
  }
  function connectPage() {
    const busy=state==='connecting';
    return wizard(0,`<div class="wizard-head"><h2>连接云服务器</h2><p>使用你已有的 SSH 登录方式。Hemi 会先检查运行环境。</p></div>
      <form id="connection-form"><div class="field"><label for="server">SSH 地址</label><input class="input" id="server" name="server" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(config.host)}" placeholder="ubuntu@服务器地址，或 SSH Host 别名" required ${busy?'disabled':''} ${state==='connect-error'?'aria-invalid="true" aria-describedby="connection-error"':''}><p class="help">支持本机 SSH 配置，包括密钥、跳板机和自定义端口。</p></div>
      <fieldset class="field" style="padding:0;border:0"><legend class="field-label" style="margin-bottom:var(--sp-8)">登录方式</legend><div class="choice-row"><label class="radio-label"><input type="radio" name="auth" value="key" ${authMode==='key'?'checked':''} ${busy?'disabled':''}>SSH 密钥</label><label class="radio-label"><input type="radio" name="auth" value="password" ${authMode==='password'?'checked':''} ${busy?'disabled':''}>密码</label></div></fieldset>
      ${authMode==='password'?`<div class="field"><label for="ssh-password">登录密码</label><input type="password" class="input" id="ssh-password" autocomplete="off" placeholder="交互稿中无需填写真实密码" ${busy?'disabled':''}><label class="check-label help"><input type="checkbox" id="remember-password">在本机记住密码</label></div>`:`<div class="inline-note">${icon('KeyRound')}<p>沿用本机的 SSH 密钥或 SSH agent。私钥不会上传到服务器。</p></div>`}
      ${state==='connect-error'?`<div class="inline-note error" id="connection-error" role="alert" style="margin-top:var(--sp-16)">${icon('CircleX')}<div><strong>登录被服务器拒绝</strong><p>请检查用户名和密钥，或切换为密码登录。已填写的地址会保留。</p></div></div>`:''}
      ${busy?`<div class="inline-note" style="margin-top:var(--sp-16)" role="status"><span class="spin">${icon('LoaderCircle')}</span>正在验证连接与运行环境…</div>`:''}
      <div class="wizard-footer">${button('返回','welcome','ghost','ArrowLeft')}<button class="btn primary large" type="submit" id="connect-submit" ${!config.host||busy?'disabled':''}>${busy?'连接中…':'连接并继续'}${icon('ArrowRight')}</button></div></form>`);
  }
  function modelFields() {
    const modelConfig=editingModel??config;
    const mode=editingModel?.modelMode??modelMode;
    return `<div class="field"><span class="field-label">云端模型</span><div class="model-choice"><label class="radio-label"><input type="radio" name="model-mode" value="local" ${mode==='local'?'checked':''}>使用本机的 API Key 配置</label>${mode==='local'?`<div class="model-summary"><strong>DeepSeek <span class="muted">/ ${esc(modelConfig.model)}</span></strong><p>仅将这个模型的接口和 Key 保存到云端。</p></div>`:''}<label class="radio-label"><input type="radio" name="model-mode" value="manual" ${mode==='manual'?'checked':''}>单独配置</label>${mode==='manual'?`<div class="manual-fields"><div class="field"><label for="endpoint">接口地址</label><input id="endpoint" class="input" type="url" value="${esc(modelConfig.endpoint)}" required></div><div class="field"><label for="model-name">模型名称</label><input id="model-name" class="input" value="${esc(modelConfig.model)}" required></div><div class="field"><label for="model-key">API Key</label><input id="model-key" class="input" type="password" autocomplete="off" placeholder="演示稿，请勿填写真实 Key"></div></div>`:''}</div><p class="help">本机的账号登录状态不会同步到服务器。</p></div>`;
  }
  function configurePage() {
    return wizard(1,`<div class="wizard-head"><h2>配置你的云端 Bot</h2><p>确认模型和工作目录，其余交给 Hemi。</p></div><div class="host-strip">${icon('Server')}<span>${esc(config.host)}</span><span class="check">${icon('Check')}环境检查通过</span><span class="host-env help">Ubuntu 24.04 · x86_64</span></div><form id="configuration-form">${modelFields()}<div class="form-divider"></div><div class="field"><label for="workdir">云端工作目录</label><input class="input" id="workdir" value="${esc(config.workdir)}" required spellcheck="false"><p class="help">Bot 可以在此目录内读写文件。需要额外权限时会等待你确认。</p></div><div class="inline-note">${icon('Info')}<p>将在服务器安装运行组件并配置开机启动。初始化会从云端发送一次短模型请求，用于验证配置。</p></div><div class="wizard-footer">${button('上一步','back-connect','ghost','ArrowLeft')}<button type="submit" class="btn primary large" id="initialize-bot">初始化 Bot${icon('ArrowRight')}</button></div></form>`);
  }
  function installPage() {
    const failed=state==='init-error', canceled=state==='init-canceled';
    const displaySteps=installSteps.map((step,i)=>i===1&&reuseInstall?['检查已有运行组件','已安装且版本兼容，直接复用']:step);
    return wizard(2,`<div class="wizard-head"><h2>${canceled?'初始化已取消':failed?'初始化尚未完成':'正在初始化云端 Bot'}</h2><p>${canceled?'已完成的步骤和配置保留，随时可以继续。':failed?'运行组件和配置已保留。处理问题后可继续，无需重装。':'完成后，Bot 将独立运行，不依赖本机保持连接。'}</p></div><div class="setup-summary"><div class="server-avatar">${icon('Server')}</div><div><strong>${esc(config.host)}</strong><small>Linux · ${esc(config.workdir)}</small></div></div><ol class="install-list" aria-live="polite">${displaySteps.map(([label,detail],i)=>`<li class="${i<installStep?'done':i===installStep?(failed?'failed':canceled?'paused':'current'):''}"><span class="install-icon">${i<installStep?icon('Check'):i===installStep?(failed?icon('CircleX'):canceled?icon('Circle'):`<span class="spin">${icon('LoaderCircle')}</span>`):icon('Circle')}</span><div class="install-copy"><strong>${label}</strong>${i===installStep||i<installStep?`<small>${i===installStep&&failed?'当前账号尚未开启退出登录后的驻留权限。':i===installStep&&canceled?'尚未完成，可以继续初始化。':detail}</small>`:''}</div></li>`).join('')}</ol>${failed?`<div class="inline-note error" role="alert">${icon('TriangleAlert')}<p>请联系服务器管理员开启当前账号的常驻权限，再点“重新检测并继续”。云端 Bot 目前尚未启动。</p></div><details class="disclosure"><summary>查看诊断信息</summary><pre>阶段：配置用户级常驻服务\n条件：退出 SSH 登录后仍需保持服务运行\n当前结果：未满足，未进入可用状态\n演示操作：本稿点击重试会模拟修复成功。</pre></details>`:`<details class="disclosure"><summary>查看初始化详情</summary><pre>${displaySteps.slice(0,installStep).map(([label])=>label+'：已完成').join('\n')}\n当前阶段：${installSteps[installStep]?.[0]??'保存连接'}${canceled?'，已暂停':'，尚未完成'}\n常驻验证会断开本次 SSH 后重连\n不会重启服务器</pre></details>`}<div class="wizard-footer">${button(failed||canceled?'返回配置':'取消初始化',failed||canceled?'configure':'cancel-init','ghost',failed||canceled?'ArrowLeft':'')}${canceled?button('继续初始化','resume-init','primary large','Play'):failed?button('重新检测并继续','retry-init','primary large','RefreshCw','id="retry-init"'):button('正在验证…','none','primary large','','disabled')}</div>`);
  }
  function composer() {
    const unavailable=['offline','unknown','stopped'].includes(state);
    const busy=['running','approval'].includes(state);
    const label=state==='stopped'?'启动 Bot 后可以继续':unavailable?'连接恢复后再发送，草稿会保留':state==='approval'?'确认或拒绝这次操作后继续':state==='running'?'任务正在云端执行':'任务在云服务器执行，关闭本机不会停止已受理任务';
    return `<div class="composer-wrap"><form id="message-form" class="composer"><label for="message" class="sr-only">给云端 Bot 发送任务</label><textarea id="message" rows="2" placeholder="给云端 Bot 一个任务…" ${state==='stopped'?'disabled':''}>${esc(draft)}</textarea><div class="composer-toolbar"><div class="composer-meta"><button class="tool workspace-tool" type="button" data-action="workspace" title="${esc(config.workdir)}">${icon('Folder')}<span>云端工作目录</span></button><button class="tool" type="button" id="composer-model-settings" data-action="model-settings" title="云端模型配置">${icon('KeyRound')}<span>${esc(config.model)}</span></button><button class="tool" type="button" data-action="permissions" aria-label="查看云端权限">${icon('ShieldCheck')}</button></div>${state==='running'?`<button type="button" class="send" data-action="stop-task" aria-label="停止当前任务" title="停止当前任务">${icon('Square')}</button>`:`<button type="submit" id="send-message" class="send" aria-label="发送任务" title="发送任务" ${unavailable||busy||!draft.trim()?'disabled':''}>${icon('ArrowUp')}</button>`}</div></form><div class="composer-caption">${label}</div></div>`;
  }
  function chatPage() {
    const offline=['offline','unknown'].includes(state), stopped=state==='stopped';
    const shownState=offline?offlineSnapshot:stopped?lastTaskState:state;
    const running=shownState==='running', approval=shownState==='approval', unknown=state==='unknown', taskStopped=shownState==='task-stopped';
    const banner=offline?`<div class="connection-banner" role="status"><div class="banner-copy">${icon('Unplug')}<div><strong>${unknown?'这条指令的受理结果还未确认':'连接已断开，云端可能仍在运行'}</strong><p>${unknown?'重连后会核对原指令，不会重复提交。':'上次同步于 14:32。连接恢复后会补齐执行结果。'}</p></div></div>${button('重新连接','reconnect','secondary','RefreshCw','id="reconnect"')}</div>`:stopped?`<div class="connection-banner"><div class="banner-copy">${icon('Power')}<div><strong>Bot 已停止</strong><p>已关闭常驻与自动启动，服务器上的文件和记录仍保留。</p></div></div>${button('启动 Bot','start-bot','primary','Play','id="start-bot"')}</div>`:'';
    if(!hasTask) return `${banner}<div class="chat-empty"><div class="bot-emblem">${icon('Bot')}</div><h1>云端 Bot</h1><p>${stopped?'启动后即可接收任务。':'连接恢复后可以继续发送任务。'}</p></div>${composer()}`;
    return `${banner}<div class="chat-scroll"><div class="read-column"><div class="date-line">今天</div><div class="user-message"><div class="user-bubble">${esc(taskText)}${unknown?'<p class="help" style="margin-top:var(--sp-6)">受理状态待核对</p>':''}</div></div>${unknown?`<p class="help">连接中断时没有收到云端回执。重新连接后将核对这条指令的状态。</p>`:`<article class="assistant-message"><p>${taskStopped?'任务已停止。已完成的检查记录保留，尚未生成摘要文件。':approvalResult==='approved'?'变更摘要已整理完成，并已推送到远端仓库。':running?'我会检查云端工作目录中的改动，整理好后把摘要文件交给你。':'已检查项目的最近改动，摘要已保存到云端工作目录。'}</p>${activity(running||taskStopped)}${taskStopped?`<div class="help">${stopped?'停止前的任务记录已保留。':'已停止当前任务，Bot 服务仍在运行。'}</div>`:approval?approvalCard(offline):running?`<div class="task-heading"><span class="spin">${icon('LoaderCircle')}</span>${offline?'上次同步：正在整理变更摘要':'正在整理变更摘要…'}</div>`:`<p>${approvalResult==='denied'?'变更摘要已经保留，未执行推送。':'这次改动主要涉及以下三项：'}</p>${approvalResult==='denied'?'':`<ul class="result-list"><li>完善了文件交付物的展示与下载。</li><li>整理了后台任务的状态和执行记录。</li><li>补充了相关功能说明与检查步骤。</li></ul>`}<button type="button" class="file-card" data-action="file"><span class="file-icon">${icon('FileText')}</span><span><strong>change-summary.md</strong><small>Markdown · 2.4 KB · 云端文件</small></span>${icon('ChevronRight')}</button><div class="result-foot"><span>${offline?'最近同步的结果':stopped?'停止前的记录':'已完成 · 在云端执行'}</span>${button('','copy-result','ghost icon','Copy','aria-label="复制结果" title="复制结果"')}</div>`}</article>`}</div></div>${composer()}`;
  }
  function activity(running) {
    return `<details class="activity" ${running?'open':''}><summary>${icon(running?'Terminal':'CheckCheck')}<span>${running?'检查项目 · 2 项操作':'查看执行过程 · 3 项操作'}</span>${icon('ChevronRight')}</summary><div class="tool-list"><div class="tool-line">${icon('Check')}<code>git status --short</code></div><div class="tool-line">${icon('Check')}<code>git log -5 --oneline</code></div>${running?'':`<div class="tool-line">${icon('Check')}<span>写入 <code>change-summary.md</code></span></div>`}</div></details>`;
  }
  function approvalCard(readonly=false) {
    return `<section class="approval" aria-label="等待授权"><div class="approval-title">${icon('ShieldCheck')}需要你确认：推送到远端仓库</div><p>摘要已经整理完成。下一步会把提交推送到项目的远端仓库。</p><code class="command">git push origin main</code><p class="help">执行位置：${esc(config.host)}<br>${esc(config.workdir)}</p><div class="row-inline"><span class="help">${readonly?'连接恢复后再处理确认':'等待确认期间不会执行'}</span><div class="approval-buttons">${button('拒绝','deny','secondary','', `id="deny-operation" ${readonly?'disabled':''}`)}${button('本次允许','approve','primary','', `id="approve-operation" ${readonly?'disabled':''}`)}</div></div></section>`;
  }
  function modal(title,body,actions,kind='') {
    return `<div class="modal-layer" data-backdrop="true"><section class="modal ${kind}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal-head"><h2 id="dialog-title">${title}</h2>${button('','close-layer','ghost icon','X','aria-label="关闭弹窗"')}</div>${body}<div class="modal-actions">${actions}</div></section></div>`;
  }
  function overlay(name) {
    if(name==='trust') return modal('确认服务器身份',`<p>首次连接 <strong>${esc(config.host)}</strong>。请与服务器提供的信息核对主机指纹。</p><code class="fingerprint">ED25519<br>SHA256:ExampleHemiCloudFingerprint7K9s<br><span class="muted">此处为交互稿的示例指纹</span></code><label class="check-label"><input type="checkbox" id="trust-checkbox">我已核对，这是我要连接的服务器</label>`,button('取消','close-layer','ghost')+button('信任并继续','trust-confirm','primary','','id="trust-confirm" disabled'));
    if(name==='settings') return `<div class="panel-layer" data-backdrop="true"><section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal-head"><h2 id="dialog-title">Bot 设置</h2>${button('','close-layer','ghost icon','X','aria-label="关闭设置"')}</div><section class="setting-section"><div class="row-inline" style="margin-bottom:var(--sp-12)"><h3 style="margin-bottom:0">云服务器</h3><span class="status ${['offline','unknown'].includes(state)?'':'online'}"><i class="dot"></i>${['offline','unknown'].includes(state)?'连接已断开':'已连接'}</span></div><dl class="setting-grid"><dt>SSH 地址</dt><dd>${esc(config.host)}</dd><dt>系统</dt><dd>Ubuntu 24.04 · x86_64</dd><dt>运行状态</dt><dd>${state==='stopped'?'已停止':state==='running'?'执行中':['offline','unknown'].includes(state)?'未知':'待命'}</dd><dt>运行组件</dt><dd>与本机版本兼容</dd></dl>${button('修改连接信息','edit-connection','link','','style="margin-top:var(--sp-16)"')}</section><section class="setting-section"><h3>模型与工作目录</h3><dl class="setting-grid"><dt>模型</dt><dd>DeepSeek / ${esc(config.model)}</dd><dt>认证</dt><dd>API Key · 已保存到云端</dd><dt>目录</dt><dd><code>${esc(config.workdir)}</code></dd></dl>${button('修改配置','model-settings','link','','id="edit-bot-configuration" style="margin-top:var(--sp-16)"')}<p class="help">与本机模型设置独立，不会自动同步修改。</p></section><section class="setting-section"><h3>连接与运行</h3>${button('查看诊断','diagnostics','setting-action','Info')}${button(state==='stopped'?'启动 Bot':'停止 Bot',state==='stopped'?'start-bot':'stop-bot','setting-action',state==='stopped'?'Play':'Power')}${button('断开连接','disconnect','setting-action','Unplug')}</section>${button('移除连接','remove','setting-action danger','Link2')}<p class="help">移除只解除本机绑定，云端数据和模型密钥仍然保留。</p></section></div>`;
    if(name==='remove') return modal('移除这台服务器的连接？',`<p>本机将回到首次引导。服务器上的文件、对话记录和模型密钥仍然保留。</p><label class="check-label"><input type="checkbox" id="stop-before-remove" checked>先停止云端 Bot，再移除连接</label><div class="inline-note">${icon('Info')}<p>移除不等于卸载。你仍可重新连接同一实例；需要彻底删除时，请按手动清理说明操作。</p></div>${button('查看手动清理说明','cleanup-help','link','','style="margin-top:var(--sp-16)"')}`,button('取消','close-layer','ghost')+button('停止并移除','confirm-remove','primary','','id="confirm-remove"'));
    if(name==='stop') return modal('停止云端 Bot？',`<p>当前任务会被中断，常驻与开机自动启动也会关闭。服务器上的文件和历史记录会保留。</p><div class="inline-note">${icon('Info')}<p>只想暂时关闭本机连接，可以选择“断开连接”，云端任务会继续。</p></div>`,button('取消','close-layer','ghost')+button('停止 Bot','confirm-stop','primary','','id="confirm-stop"'));
    if(name==='cancel-init') return modal('取消这次初始化？',`<p>已安装的组件和已保存的配置会保留。下次进入可以重新检测并继续，不会重复安装。</p>`,button('继续初始化','close-layer','ghost')+button('取消初始化','confirm-cancel-init','primary'));
    if(name==='permissions') return modal('云端工作范围',`<p>允许 Bot 访问所选工作目录。目录内的命令仍按 Hemi 的动作分级处理。</p><code class="fingerprint">${esc(config.workdir)}</code><p>需要新增授权时，Bot 会暂停等待你的确认。本机离线不会自动批准操作。</p>`,button('知道了','close-layer','primary'));
    if(name==='workspace') return modal('云端工作目录',`<p>文件和命令均在这台服务器上执行，不会操作本机文件。</p><code class="fingerprint">${esc(config.host)}<br>${esc(config.workdir)}</code>`,button('知道了','close-layer','primary'));
    if(name==='file') return modal('change-summary.md',`<p class="help">${esc(config.host)} · ${esc(config.workdir)}</p><div class="file-preview">项目变更摘要\n\n1. 完善文件交付物的展示与下载。\n2. 整理后台任务的状态和执行记录。\n3. 补充功能说明与检查步骤。\n\n这是交互稿生成的示例文件。</div>`,button('关闭','close-layer','ghost')+button('下载文件','download','primary','Download'));
    if(name==='diagnostics') return modal('连接诊断',`<dl class="setting-grid"><dt>服务器</dt><dd>${esc(config.host)}</dd><dt>运行组件</dt><dd>版本兼容</dd><dt>常驻配置</dt><dd>已配置</dd><dt>模型连通性</dt><dd>上次检查通过</dd><dt>最后同步</dt><dd>今天 14:32</dd></dl><div class="inline-note">${icon('Info')}<p>这里只展示演示数据，不读取真实主机或凭据。</p></div>`,button('关闭','close-layer','primary'));
    if(name==='edit-connection') return modal('修改连接信息',`<div class="field"><label for="edit-host">SSH 地址</label><input class="input" id="edit-host" value="${esc(config.host)}" placeholder="ubuntu@服务器地址"></div><p>保存时会核对原 Bot 实例身份，地址变化不会创建新的 Bot。</p>`,button('取消','close-layer','ghost')+button('保存并验证','save-connection','primary'));
    if(name==='model') return modal('模型与工作目录',`${modelFields()}<div class="field"><label for="workdir">云端工作目录</label><input class="input" id="workdir" value="${esc((editingModel??config).workdir)}"></div><p class="help">修改仅影响云端 Bot，新任务使用新配置。</p>`,button('取消','close-layer','ghost')+button('保存配置','save-model','primary'));
    if(name==='cleanup') return modal('手动清理云端安装',`<p>请在服务器中先停止对应服务，再核对安装位置。此交互稿不会执行卸载命令。</p><code class="fingerprint">安装与配置：~/.hemi-bot/\n工作文件：${esc(config.workdir)}</code><p>删除配置目录会移除其中保存的模型密钥。工作目录单独保留，清理前请先备份需要的文件。</p>`,button('返回','close-layer','primary'));
    return '';
  }
  function openLayer(name) { const el=document.activeElement;focusReturn=el?.id?'#'+CSS.escape(el.id):el?.dataset.action?'[data-action="'+el.dataset.action+'"]':'#bot-settings';layerStack.push({name:layer,focus:focusReturn});if(name==='model')editingModel={...config,modelMode};layer=name;render(); }
  function closeLayer() { const was=layer;const previous=layerStack.pop();layer=previous?.name??null;if(was==='model')editingModel=null;if(was==='trust')state='connect';render();const selector=was==='trust'?'#connect-submit':previous?.focus??'#bot-settings';[...app.querySelectorAll(selector)].find(el=>!el.closest('[inert]')&&el.getClientRects().length)?.focus({preventScroll:true}); }
  function connect() {
    if (!config.host.trim()) return;
    go('connecting');
    timer=setTimeout(()=>{ if(config.host.includes('fail')) go('connect-error'); else openLayer('trust'); },700);
  }
  function startInit(from=0) {
    clearTimeout(initTimer);reuseInstall=installed; initRunning=true; layer=null; layerStack=[]; state='initializing'; lastBot=state; installStep=from; render();app.querySelector('[data-action="cancel-init"]')?.focus({preventScroll:true});
    const advance=()=>{if(!initRunning||layer==='cancel-init')return;installStep++;if(installStep>=2)installed=true;if(installStep>=installSteps.length){bound=true;initRunning=false;if(state==='home'){lastBot='initialized';}else{go('initialized');}return;}if(state==='initializing')render();initTimer=setTimeout(advance,700);};
    initTimer=setTimeout(advance,700);
  }
  function finishDemoTask(){remoteState='complete';lastTaskState='complete';if(state==='home'&&lastBot==='running'){lastBot='complete';}else if(state==='running'){state='complete';lastBot=state;render();}}
  function runTask(text) { if(!text.trim()||['offline','unknown','stopped','running','approval'].includes(state))return; taskText=text.trim(); draft=''; hasTask=true; approvalResult=null;remoteState='running';go('running');taskTimer=setTimeout(finishDemoTask,1700); }
  function download() { const blob=new Blob(['# 项目变更摘要\n\n此文件来自 Hemi Bot 交互稿，内容为演示数据。\n\n- 完善文件交付物的展示与下载。\n- 整理后台任务的状态和执行记录。\n- 补充功能说明与检查步骤。\n'],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='示例-change-summary.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('示例文件已下载'); }
  app.addEventListener('submit', e=>{
    e.preventDefault();
    if(e.target.id==='connection-form') connect();
    if(e.target.id==='configuration-form') { const path=$('#workdir').value.trim();if(!path.startsWith('/')){$('#workdir').setCustomValidity('请输入以 / 开头的云端绝对路径');$('#workdir').reportValidity();return;}config.workdir=path;startInit(); }
    if(e.target.id==='message-form') runTask(draft);
  });
  app.addEventListener('input',e=>{
    const el=e.target;
    if(el.id==='server') {config.host=el.value;$('#connect-submit').disabled=!el.value.trim();}
    if(el.id==='message') {draft=el.value;const send=$('#send-message');if(send)send.disabled=!draft.trim()||['offline','unknown','stopped','approval','running'].includes(state);}
    if(el.id==='workdir'){el.setCustomValidity('');if(layer==='model')editingModel.workdir=el.value;else config.workdir=el.value;}
    if(el.id==='endpoint')(editingModel??config).endpoint=el.value;
    if(el.id==='model-name')(editingModel??config).model=el.value;
  });
  app.addEventListener('change',e=>{
    if(e.target.name==='auth') {authMode=e.target.value;render();}
    if(e.target.name==='model-mode') {if(editingModel)editingModel.modelMode=e.target.value;else modelMode=e.target.value;render();}
    if(e.target.id==='trust-checkbox') $('#trust-confirm').disabled=!e.target.checked;
    if(e.target.id==='stop-before-remove') $('#confirm-remove').textContent=e.target.checked?'停止并移除':'仅移除连接';
  });
  app.addEventListener('click',async e=>{
    const target=e.target.closest('[data-action]');
    if(!target||target.disabled)return;
    const action=target.dataset.action;
    if(action==='create') {go('connect');$('#server')?.focus();}
    else if(action==='welcome') go('welcome');
    else if(action==='back-connect') go('connect');
    else if(action==='configure') go('configure');
    else if(action==='trust-confirm'&&$('#trust-checkbox')?.checked) go('configure');
    else if(action==='retry-init')startInit(3);
    else if(action==='resume-init')startInit(installStep);
    else if(action==='enter-bot'){bound=true;go('ready');}
    else if(action==='example'){draft=target.dataset.prompt;render();$('#message')?.focus();}
    else if(action==='home'){lastBot=state==='connecting'?'connect':state;go('home');}
    else if(action==='bot'){const saved=lastBot;go(saved==='home'?(bound?'complete':'welcome'):saved);}
    else if(action==='reconnect') {const wasUnknown=state==='unknown';target.disabled=true;target.innerHTML=icon('LoaderCircle')+'正在核对…';timer=setTimeout(()=>{const restored=remoteState;go(restored);toast(wasUnknown?'已核对：原指令已受理，正在云端执行':'已重新连接，云端记录已同步');if(wasUnknown){clearTimeout(taskTimer);taskTimer=setTimeout(finishDemoTask,1700);}},850);}
    else if(action==='disconnect'){offlineSnapshot=state;go('offline');}
    else if(action==='start-bot'){remoteState=hasTask?lastTaskState:'ready';go(remoteState);toast('Bot 已启动，常驻与自动启动已恢复');}
    else if(action==='stop-task'){clearTimeout(taskTimer);remoteState='task-stopped';lastTaskState='task-stopped';go('task-stopped');statusMessage='当前任务已停止，已完成的文件保留。';toast(statusMessage);}
    else if(action==='stop-bot')openLayer('stop');
    else if(action==='confirm-stop'){if(['offline','unknown'].includes(state)){toast('连接已断开，无法确认停止。请重新连接后处理。');return;}clearTimeout(taskTimer);if(['running','approval'].includes(state))lastTaskState='task-stopped';else if(hasTask)lastTaskState=state;remoteState='stopped';go('stopped');toast('云端 Bot 已停止');}
    else if(action==='approve'){if(['offline','unknown'].includes(state))return;remoteState='complete';lastTaskState='complete';approvalResult='approved';layer=null;state='complete';lastBot=state;render();toast('已允许本次推送，演示任务已完成');}
    else if(action==='deny'){if(['offline','unknown'].includes(state))return;remoteState='complete';lastTaskState='complete';approvalResult='denied';layer=null;state='complete';lastBot=state;render();}
    else if(action==='close-layer') {const was=layer;closeLayer();if(was==='cancel-init')startInit(installStep);}
    else if(action==='cancel-init'){clearTimeout(initTimer);openLayer('cancel-init');}
    else if(action==='confirm-cancel-init'){initRunning=false;clearTimeout(initTimer);go('init-canceled');toast('初始化已取消，已有组件和配置保留');}
    else if(action==='confirm-remove'){const stop=$('#stop-before-remove').checked;if(stop&&['offline','unknown'].includes(state)){toast('尚未连接，无法确认停止。请恢复连接后重试。');return;}reset();go('welcome');toast(stop?'已停止云端 Bot，并移除本机连接':'已移除本机连接，云端 Bot 仍可能运行');}
    else if(action==='save-connection'){const input=$('#edit-host');if(!input.value.trim()){input.setCustomValidity('请填写 SSH 地址');input.reportValidity();return;}config.host=input.value.trim();closeLayer();toast('演示验证通过，仍连接原 Bot 实例');}
    else if(action==='save-model'){const endpoint=$('#endpoint');if(endpoint&&!endpoint.checkValidity()){endpoint.reportValidity();return;}const input=$('#workdir');if(!input.value.startsWith('/')){input.setCustomValidity('请输入云端绝对路径');input.reportValidity();return;}const {modelMode:nextMode,...settings}=editingModel;Object.assign(config,settings,{workdir:input.value});modelMode=nextMode;closeLayer();toast('演示配置已保存，新任务将使用新配置');}
    else if(action==='download')download();
    else if(action==='copy-result'){try{await navigator.clipboard.writeText('项目变更摘要：文件交付、后台任务状态、功能说明。');toast('已复制示例结果');}catch{toast('当前预览环境不支持剪贴板');}}
    else if(action==='model-settings') {if(['offline','unknown'].includes(state)){toast('请先恢复连接，再修改云端配置');return;}if(state==='running'||state==='approval'){toast('请先结束当前任务，再修改模型与工作目录');return;}openLayer('model');}
    else if(action==='cleanup-help')openLayer('cleanup');
    else if(action==='identity-back')go(bound?'offline':'connect');
    else if(['settings','remove','permissions','workspace','file','diagnostics','edit-connection'].includes(action))openLayer(action);
  });
  document.addEventListener('keydown',e=>{
    if(layer&&e.key==='Escape'){e.preventDefault();const was=layer;closeLayer();if(was==='cancel-init')startInit(installStep);return;}
    if(layer&&e.key==='Tab'){
      const dialog=app.querySelector('[role="dialog"]');
      const items=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
    if(e.target.id==='message'&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();runTask(draft);}
  });
  globalThis.hemiBotPrototype={
    showScene,
    snapshot:()=>({state:current(),page:state,layer,bound,draft,installStep,modelMode,host:config.host,workdir:config.workdir,hasRealNetwork:false}),
    scenarios:scenes.map(([key,label])=>({key,label}))
  };
  // Compatibility with the repository's existing standalone design renderer.
  globalThis.hemiWorkspacePrototype={snapshot:()=>globalThis.hemiBotPrototype.snapshot()};
  const initial=params.get('state')||'welcome';
  showScene(scenes.some(([key])=>key===initial)?initial:'welcome');
})();
