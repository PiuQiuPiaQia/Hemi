/* Hemi Bot v2: isolated design prototype. All cloud/model/file data are synthetic. */
(() => {
'use strict';
const $=q=>document.querySelector(q);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>globalThis.botIcons[name]??'';
const button=(text,action,kind='ghost',i='',attrs='')=>`<button type="button" class="btn ${kind}" data-action="${action}" ${attrs}>${i?icon(i):''}${text}</button>`;
const params=new URLSearchParams(location.search);
document.body.classList.toggle('canvas',params.get('canvas')==='1');
const app=$('#app');
const scenes=[['welcome','首次进入'],['connect','连接服务器'],['trust','首次指纹确认'],['configure','选择模型与默认空间'],['initializing','初始化'],['init-error','初始化失败'],['ready','新会话'],['complete','多会话对话'],['custom-folder','会话独立目录'],['model-sync','顶部手动同步模型'],['model-picker','会话选择模型'],['folder-picker','浏览云端文件夹'],['folder-error','目录无权限'],['folder-loading','加载服务器目录'],['folder-list-error','目录加载失败'],['running','会话后台执行'],['queued','跨会话排队'],['approval','等待授权'],['offline','连接中断'],['offline-approval','离线授权只读'],['sync-unknown','同步结果待核对'],['sync-confirmed','重连确认同步结果'],['offline-file','离线文件信息'],['settings','Bot 设置']];
const localModels=[
 {key:'deepseek/deepseek-chat',name:'DeepSeek Chat',provider:'DeepSeek',providerId:'deepseek',id:'deepseek-chat',auth:'API Key',revision:1,canSync:true},
 {key:'aliyun/qwen-plus',name:'Qwen Plus',provider:'阿里云',providerId:'aliyun',id:'qwen-plus',auth:'API Key',revision:2,canSync:true},
 {key:'claude/claude-sonnet',name:'Claude Sonnet',provider:'Claude',providerId:'claude',id:'claude-sonnet',auth:'账号登录',revision:1,canSync:false,reason:'暂不支持云端授权'},
 {key:'local/local-model',name:'本机模型',provider:'本机接口',providerId:'local',id:'local-model',auth:'本机地址',revision:1,canSync:false,reason:'本机地址不可用'}
];
const tree={'/':['home','srv'],'/home':['ubuntu'],'/home/ubuntu':['hemi-workspace','projects','reports'],'/home/ubuntu/hemi-workspace':[],'/home/ubuntu/projects':['atlas','docs'],'/home/ubuntu/projects/atlas':['src','docs'],'/home/ubuntu/projects/atlas/src':[],'/home/ubuntu/projects/atlas/docs':[],'/home/ubuntu/projects/docs':[],'/home/ubuntu/reports':[],'/srv':['projects'],'/srv/projects':['site','api'],'/srv/projects/site':['src','public'],'/srv/projects/site/src':[],'/srv/projects/site/public':[],'/srv/projects/api':[]};
const config={host:'',workdir:'/home/ubuntu/hemi-workspace',model:'deepseek/deepseek-chat'};
let state='welcome',layer=null,stack=[],authMode='key',bound=false,online=true,enabled=true,lastBotPage='welcome';
let installStep=2,installed=false,reuseInstall=false,initTimer=null,connectTimer=null,initRunning=false;
let sessions=[],activeId=null,nextId=4,nextRun=10,remoteModels={},cachedModels={},cachedSessions=[];
let syncDraft=new Set(['deepseek/deepseek-chat','aliyun/qwen-plus']),syncPhase='idle',syncError='',syncTimer=null,syncInFlight=false,syncReconciled=false;
let picker=null,drawer=false,focusReturn=null,fixtureAlias=null,connectionBusy=false,queueTimers=new Map(),folderTimer=null,recentFolders=[];
let afterSetupModels=new Set(['deepseek/deepseek-chat','aliyun/qwen-plus']);
const installSteps=[['检查运行环境','Linux、安装权限和常驻条件已就绪'],['安装云端运行组件','独立安装，不修改系统 Node 环境'],['同步模型与默认空间','保存所选模型，验证默认模型与目录权限'],['启动并验证常驻','断开 SSH 后重连，确认服务继续运行'],['保存连接','下次进入直接打开 Bot 会话页']];
const copy=value=>JSON.parse(JSON.stringify(value));
const local=key=>localModels.find(m=>m.key===key);
const cloudModel=(key,revision=local(key).revision)=>{const m=local(key);return{name:m.name,provider:m.provider,providerId:m.providerId,modelId:m.id,auth:m.auth,revision,usable:true};};
const normalizePath=path=>path.trim().replace(/\/+$/,'')||'/';
const syncCandidates=()=>localModels.filter(m=>m.canSync&&(!cachedModels[m.key]||cachedModels[m.key].revision<m.revision)).map(m=>m.key);
const modelChoices=()=>[...Object.entries(cachedModels).map(([key,m])=>({...m,key})),...localModels.filter(m=>!cachedModels[m.key])];
const basename=path=>path==='/'?'/':path.split('/').filter(Boolean).at(-1);
const pathLabel=path=>path===config.workdir?'默认空间':basename(path);
const active=()=>sessions.find(s=>s.id===activeId);
const visibleSessions=()=>online?sessions:cachedSessions;
const visibleActive=()=>visibleSessions().find(s=>s.id===activeId)??visibleSessions()[0];
const busy=s=>Boolean(s?.runs.some(r=>['running','queued','approval','unknown'].includes(r.status)));
const latest=s=>s?.runs.at(-1);
function setCache(){cachedSessions=copy(sessions);cachedModels=copy(remoteModels);}
function modelName(key){return cachedModels[key]?.name??(!bound?local(key)?.name:null)??key;}
function blankSession(id,title='新会话',model=config.model,cwd=config.workdir){return{id,title,model,cwd,draft:'',notice:'',runs:[]};}
function fixtureRun(id,text,model,cwd,status='complete'){return{id,text,model,revision:remoteModels[model]?.revision??1,modelName:modelName(model),cwd,cwdLabel:pathLabel(cwd),status,result:'summary',artifactPath:cwd+'/change-summary.md'};}
function resetData(){
 clearTimeout(initTimer);clearTimeout(connectTimer);clearTimeout(syncTimer);clearTimeout(folderTimer);for(const timer of queueTimers.values())clearTimeout(timer);queueTimers.clear();
 state='welcome';layer=null;stack=[];bound=false;online=true;enabled=true;installed=false;initRunning=false;drawer=false;picker=null;connectionBusy=false;fixtureAlias=null;syncInFlight=false;syncReconciled=false;recentFolders=[];
 sessions=[];activeId=null;nextId=4;nextRun=10;remoteModels={};cachedModels={};cachedSessions=[];config.host='';config.workdir='/home/ubuntu/hemi-workspace';config.model='deepseek/deepseek-chat';syncPhase='idle';syncError='';syncDraft=new Set(['deepseek/deepseek-chat','aliyun/qwen-plus']);afterSetupModels=new Set(syncDraft);
}
function seedSessions(){
 remoteModels={'deepseek/deepseek-chat':cloudModel('deepseek/deepseek-chat',1),'aliyun/qwen-plus':cloudModel('aliyun/qwen-plus',1)};cachedModels=copy(remoteModels);recentFolders=['/srv/projects/site','/home/ubuntu/projects/docs'];
 const a=blankSession('s1','项目改动摘要');a.runs.push(fixtureRun('r1','检查项目最近的改动，整理成一份变更摘要。',a.model,a.cwd));
 const b=blankSession('s2','站点部署检查','aliyun/qwen-plus','/srv/projects/site');b.runs.push(fixtureRun('r2','检查站点项目，整理部署前的检查项。',b.model,b.cwd));
 const c=blankSession('s3','文档整理','deepseek/deepseek-chat','/home/ubuntu/projects/docs');
 sessions=[a,b,c];activeId='s1';bound=true;installed=true;setCache();
}
function showScene(name){
 resetData();if(name!=='welcome')config.host='ubuntu@hemi-cloud';
 const setup=['welcome','connect','trust','configure','initializing','init-error'];
 if(!setup.includes(name)){seedSessions();state='bot';}else state=name;
 if(name==='trust'){state='connect';layer='trust';}
 if(name==='configure')remoteModels={};
 if(name==='initializing'){installed=true;installStep=2;}
 if(name==='init-error'){installed=true;installStep=3;}
 if(name==='ready'){activeId='s3';}
 if(name==='custom-folder'){activeId='s2';}
 if(name==='model-sync'){layer='sync';syncDraft=new Set(syncCandidates());}
 if(name==='model-picker'){layer='model-picker';}
 if(['folder-picker','folder-error','folder-loading','folder-list-error'].includes(name)){layer='folder';picker={purpose:'session',sessionId:'s1',path:'/home/ubuntu',input:name==='folder-error'?'/root':'/home/ubuntu',entries:[...tree['/home/ubuntu']],loading:name==='folder-loading',request:0,addressEdited:false,errorKind:name==='folder-error'?'permission':'read',error:name==='folder-error'?'无法访问 /root：当前云端账号没有权限。':name==='folder-list-error'?'暂时无法读取服务器文件夹，请重试。':''};if(picker.loading||picker.error)picker.entries=[];}
 if(name==='running'){active().runs[0].status='running';}
 if(name==='queued'){sessions[0].runs[0].status='running';activeId='s2';sessions[1].runs[0].status='queued';}
 if(name==='approval'||name==='offline-approval'){const r=active().runs[0];r.status='approval';r.text='整理项目变更摘要，并同步已有提交到远端仓库。';}
 if(name==='offline'||name==='offline-approval'){setCache();online=false;active().draft='再检查一下有没有遗漏的文件';cachedSessions=copy(sessions);}
 if(name==='sync-unknown'){setCache();remoteModels['aliyun/qwen-plus']=cloudModel('aliyun/qwen-plus');online=false;syncPhase='unknown';}
 if(name==='sync-confirmed'){remoteModels['aliyun/qwen-plus']=cloudModel('aliyun/qwen-plus');setCache();syncPhase='done';syncReconciled=true;}
 if(name==='offline-file'){setCache();online=false;layer='file';picker={runId:'r1'};}
 if(name==='settings')layer='settings';
 fixtureAlias=name;lastBotPage=state;render();
}
function current(){return fixtureAlias??(state==='bot'?(layer??(!online?'offline':enabled?(latest(active())?.status??'ready'):'stopped')):state);}
function toast(text){const el=$('#toast');el.textContent=text;el.hidden=false;setTimeout(()=>el.hidden=true,2300);}
function headerStatus(){if(!online)return['连接已断开',''];if(!enabled)return['已停止',''];if(state==='bot'){const pending=visibleSessions().filter(s=>latest(s)?.status==='approval').length;return[pending?`${pending} 个会话等待确认`:'已连接',pending?'waiting':'online'];}if(['configure','initializing','init-error','init-canceled','initialized'].includes(state))return['服务器已连接','online'];return[state==='connecting'?'连接中':'尚未连接',''];}
function hasConversationLayout(){return state==='bot';}
function nav(){return `<nav class="rail" aria-label="应用导航"><button type="button" class="nav-btn" data-action="home" aria-label="对话" title="对话">${icon('MessageCircle')}</button><button type="button" class="nav-btn" disabled title="技能中心（现有页面）" aria-label="技能中心，原型未包含">${icon('Sparkles')}</button><button type="button" class="nav-btn" disabled title="工作流（现有页面）" aria-label="工作流，原型未包含">${icon('Workflow')}</button><button type="button" class="nav-btn" data-action="bot" aria-current="${state!=='home'?'page':'false'}" aria-label="Bot" title="Bot">${icon('Bot')}</button><div class="rail-space"></div><button type="button" class="nav-btn" disabled title="现有换肤入口">${icon('Shirt')}</button><button type="button" class="nav-btn" disabled title="现有全局设置">${icon('Settings')}</button></nav>`;}
function sessionList(){return `<div class="session-list">${visibleSessions().map(s=>{const run=latest(s),status=run?.status,statusText=({running:'执行中',approval:'等待确认',queued:'排队中'})[status]??'';return `<button type="button" class="session-item" data-action="switch-session" data-session="${s.id}" aria-current="${s.id===activeId?'true':'false'}" aria-label="${esc(s.title)}${statusText?'，'+statusText:''}" title="${esc(s.title)}${statusText?' · '+statusText:''} · ${esc(pathLabel(s.cwd))} · ${esc(modelName(s.model))}"><span class="session-name">${esc(s.title)}</span>${status==='running'?`<span class="running-dot spin">${icon('LoaderCircle')}</span>`:status==='approval'?icon('ShieldCheck'):status==='queued'?'<span class="session-tag">排队中</span>':''}</button>`;}).join('')}</div>`;}
function sidebarContent(inDrawer=false){return `${button('新建会话','new-session','ghost new-session','Plus',`id="${inDrawer?'drawer-new-session':'new-session'}" `+(!online?'disabled title="重新连接后可新建会话"':''))}<div class="sidebar-label">最近会话</div>${sessionList()}<div class="sidebar-server"><strong>${icon('Server')}云服务器</strong><p title="${esc(config.host)}">${esc(config.host)}</p></div>`;}
function render(){
 const old=document.activeElement;const focus=old?.id?'#'+CSS.escape(old.id):old?.dataset.action?'[data-action="'+old.dataset.action+'"]':null;
 const layout=hasConversationLayout(),s=visibleActive(),[status,cls]=headerStatus();app.classList.toggle('with-sessions',layout);
 app.innerHTML=`<div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div><header class="topbar"><div class="top-title"><strong>${layout?'Hemi Bot':'Bot'}</strong></div>${layout?`${button('','toggle-drawer','ghost icon nav-toggle','PanelLeft','id="session-drawer-trigger" aria-label="会话列表"')}<div class="current-session-title" title="${esc(s?.title)}">${esc(s?.title??'新会话')}</div>`:''}<div class="top-actions"><span class="status ${cls}" title="${status}" role="status" aria-label="${status}"><i class="dot"></i><span class="status-text">${status}</span></span>${bound||state==='configure'?button('<span class="sync-label">同步模型</span>','sync-models','ghost top-sync','RefreshCw','id="sync-models" aria-label="同步本机模型" title="手动同步本机模型" '+(!online?'disabled':'')):''}${layout?button('','settings','ghost icon','Settings','id="bot-settings" aria-label="Bot 设置"'):''}</div></header>${nav()}${layout?`<aside class="conversation-sidebar" aria-label="Bot 会话列表">${sidebarContent()}</aside>`:''}<main class="surface" aria-label="Bot">${page()}${layer?overlay(layer):''}${drawer?`<div class="drawer-layer"><section class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div class="modal-head"><h2 id="drawer-title">Bot 会话</h2>${button('','close-drawer','ghost icon','X','aria-label="关闭会话列表"')}</div>${sidebarContent(true)}</section></div>`:''}</main>`;
 if(layer||drawer){app.querySelectorAll('header,nav,.conversation-sidebar,.surface>:not(.modal-layer):not(.panel-layer):not(.drawer-layer)').forEach(el=>el.inert=true);app.querySelector('[role="dialog"] button:not(:disabled),[role="dialog"] input:not(:disabled)')?.focus({preventScroll:true});}
 if(focus){[...app.querySelectorAll(focus)].find(el=>!el.closest('[inert]')&&el.getClientRects().length)?.focus({preventScroll:true});}
 app.dataset.state=current();$('#scene-picker').value=scenes.some(([key])=>key===current())?current():state==='bot'?'complete':state;
 const url=new URL(location.href);url.searchParams.set('state',current());history.replaceState(null,'',url);
}
function go(next){clearTimeout(connectTimer);layer=null;stack=[];drawer=false;fixtureAlias=null;state=next;if(next!=='home')lastBotPage=next;render();}
function page(){
 if(state==='welcome')return `<div class="page-scroll center-stage"><section class="welcome fade-in"><div class="bot-emblem">${icon('Bot')}</div><h1>让 Hemi 在云端持续工作</h1><p>连接 Linux 服务器，把本机模型同步给 Bot。<br>按不同任务创建会话，选择云端工作目录。</p>${button('创建连接','create','primary large','Plug','id="create-connection"')}<div class="welcome-note">${icon('LockKeyhole')}通过 SSH 安全连接</div><div class="welcome-caption"><span>${icon('MessageCircle')}多个会话</span><span>${icon('Folder')}云端工作空间</span></div></section></div>`;
 if(['connect','connecting','connect-error'].includes(state))return connectPage();
 if(state==='configure')return configurePage();
 if(['initializing','init-error','init-canceled'].includes(state))return installPage();
 if(state==='initialized')return wizard(3,`<div class="wizard-head"><div class="bot-emblem">${icon('CircleCheck')}</div><h2>云端 Bot 已准备就绪</h2><p>已同步 ${Object.keys(remoteModels).length} 个模型，并建立云端默认空间。<br>接下来可以创建会话，分别选择模型和目录。</p></div><div class="setup-summary"><span class="server-avatar">${icon('Server')}</span><div><strong>${esc(config.host)}</strong><small>常驻运行 · 开机启动已配置</small></div></div><div class="wizard-footer">${button('开始使用','enter-bot','primary large','ArrowRight','id="enter-bot"')}</div>`);
 if(state==='home')return `<div class="chat-empty"><h1>普通对话</h1><p>这里保留现有页面位置，Bot 的会话在云端继续。</p>${button('返回 Bot','bot','secondary large','Bot')}</div>`;
 return botPage();
}
function configurePage(){const selected=[...afterSetupModels].filter(key=>local(key)?.canSync);return wizard(1,`<div class="wizard-head"><h2>初始化你的云端 Bot</h2><p>从本机模型列表选择同步，工作从云端默认空间开始。</p></div><div class="host-strip">${icon('Server')}<span>${esc(config.host)}</span><span class="check">${icon('Check')}环境检查通过</span></div><div class="field"><span class="field-label">同步本机模型</span><div class="model-sync-summary"><div><strong>已选择 ${selected.length} 个模型</strong><p class="help">${selected.map(modelName).join('、')||'请选择至少一个可用模型'}</p></div>${button('选择模型','sync-models','secondary','RefreshCw','id="configure-sync"')}</div></div><div class="field default-model"><label for="default-model">新会话的默认模型</label><select class="input" id="default-model">${selected.map(key=>`<option value="${key}" ${key===config.model?'selected':''}>${esc(modelName(key))}</option>`).join('')}</select></div><div class="form-divider"></div><div class="field"><span class="field-label">默认空间 <span class="muted">/ 云端</span></span><button type="button" class="folder-select" data-action="choose-default-folder">${icon('Folder')}<code>${esc(config.workdir)}</code>${icon('ChevronRight')}</button><p class="help">新会话默认使用此空间，也可以单独选择其他云端文件夹。</p></div><div class="inline-note">${icon('Info')}<p>初始化时保存所选模型配置，验证云端调用并配置常驻。以后在页面顶部点“同步模型”手动更新。</p></div><div class="wizard-footer">${button('上一步','back-connect','ghost','ArrowLeft')}${button('初始化 Bot','initialize','primary large','ArrowRight','id="initialize-bot" '+(!selected.length?'disabled':''))}</div>`);}
function connectionBanner(){
 if(!online)return `<div class="connection-banner"><div class="banner-copy">${icon('Unplug')}<div><strong>连接已断开，云端可能仍在运行</strong><p>保留最近同步记录和各会话草稿；恢复后核对状态。</p>${syncPhase==='unknown'?'<p id="sync-reconcile-status">模型同步结果待核对，重新连接后查看云端确认。</p>':''}</div></div>${button('重新连接','reconnect','secondary','RefreshCw','id="reconnect"')}</div>`;
 if(syncReconciled)return `<div class="connection-banner" role="status"><div class="banner-copy">${icon('CircleCheck')}<div><strong id="sync-reconcile-status">云端已确认模型同步结果</strong><p>已恢复云端可用模型目录，任务仍使用受理时的版本。</p></div></div>${button('知道了','dismiss-sync','ghost')}</div>`;
 if(syncPhase==='syncing'&&syncError==='reconciling')return `<div class="connection-banner" role="status"><div class="banner-copy"><span class="spin">${icon('LoaderCircle')}</span><strong id="sync-reconcile-status">正在核对模型同步结果…</strong></div></div>`;
 if(!enabled)return `<div class="connection-banner"><div class="banner-copy">${icon('Power')}<div><strong>Bot 已停止</strong><p>会话、模型和云端文件都保留。</p></div></div>${button('启动 Bot','start-bot','primary','Play','id="start-bot"')}</div>`;
 return '';
}
function botPage(){const s=visibleActive();if(!s)return '<div class="chat-empty"><p>尚无会话</p></div>';return `${connectionBanner()}${s.runs.length?`<div class="chat-scroll"><div class="read-column"><div class="date-line">今天</div>${s.runs.map(renderRun).join('')}${s.notice?`<div class="context-notice">${esc(s.notice)}</div>`:''}</div></div>`:`<div class="chat-empty"><div class="bot-emblem">${icon('Bot')}</div><h1>新会话，从这里开始</h1><p>使用${esc(pathLabel(s.cwd))}，任务在云服务器上执行。</p><div class="prompt-row"><button type="button" data-action="example">整理这个目录里的项目改动</button></div></div>`}${composer(s)}`;}
function renderRun(run){const frozen=`<div class="run-meta"><span>${icon('KeyRound')}${esc(run.modelName??modelName(run.model))}</span><span title="${esc(run.cwd)}">${icon('Folder')}${esc(run.cwdLabel??basename(run.cwd))}</span></div>`;const pending=['queued','running','approval'].includes(run.status);return `<section class="task-block" data-run="${run.id}"><div class="user-message"><div class="user-bubble">${esc(run.text)}</div></div><article class="assistant-message">${run.status==='queued'?`<div class="queue-state">${icon('Clock3')}<div>已受理，排队中<p>另一个会话正在运行或等待确认，完成后继续。</p></div></div>`:run.status==='running'?`<p>我会在这个会话选定的云端目录里检查改动。</p><details class="activity" open><summary>${icon('Terminal')}检查项目 · 2 项操作${icon('ChevronRight')}</summary><div class="tool-list"><div class="tool-line">${icon('Check')}<code>git status --short</code></div><div class="tool-line">${icon('Check')}<code>git log -5 --oneline</code></div></div></details><div class="task-heading"><span class="spin">${icon('LoaderCircle')}</span>${online?'正在整理变更摘要…':'上次同步：正在执行'}</div>`:run.status==='approval'?approvalCard(run):run.status==='stopped'?`<p>任务已停止。已完成的记录保留，没有重放未完成的操作。</p>`:`<p>${run.result==='denied'?'摘要已保留，没有执行推送。':run.result==='pushed'?'摘要已保留，已有提交已同步到远端仓库。':'已检查项目最近改动，摘要已保存到这次任务的云端目录。'}</p><details class="activity"><summary>${icon('CheckCheck')}查看执行过程 · 3 项操作${icon('ChevronRight')}</summary><div class="tool-list"><div class="tool-line">${icon('Check')}<code>git status --short</code></div><div class="tool-line">${icon('Check')}<code>git log -5 --oneline</code></div><div class="tool-line">${icon('Check')}写入 change-summary.md</div></div></details><p>主要涉及文件交付、任务状态和相关功能说明。</p><button type="button" class="file-card" data-action="file" data-run="${run.id}" style="margin-top:var(--sp-20)"><span class="file-icon">${icon('FileText')}</span><span><strong>change-summary.md</strong><small>Markdown · 云端文件</small></span>${icon('ChevronRight')}</button>`}${frozen}${!pending?`<div class="result-foot">${run.status==='stopped'?'已停止':'已完成'} · 记录属于当前会话</div>`:''}</article></section>`;}
function approvalCard(run){return `<section class="approval"><div class="approval-title">${icon('ShieldCheck')}需要确认：同步已有提交到远端仓库</div><p>此操作只针对本会话选定的云端项目。</p><code class="command">git push origin main</code><p class="help">${esc(config.host)}<br>${esc(run.cwd)}</p><div class="row-inline"><span class="help">${online?'等待确认期间不会执行':'恢复连接后再处理'}</span><div class="approval-buttons">${button('拒绝','deny','secondary','',`data-run="${run.id}" ${!online?'disabled':''}`)}${button('本次允许','approve','primary','',`data-run="${run.id}" ${!online?'disabled':''}`)}</div></div></section>`;}
function composer(s){const blocked=!online||!enabled||busy(s);return `<div class="composer-wrap"><form id="message-form" class="composer"><label class="sr-only" for="message">给当前云端会话发送任务</label><textarea id="message" rows="2" placeholder="给云端 Bot 一个任务…">${esc(s.draft)}</textarea><div class="composer-toolbar context-toolbar"><div class="composer-meta"><button type="button" class="tool workspace-tool" id="session-folder" data-action="choose-session-folder" title="云端目录：${esc(s.cwd)}" ${!online||busy(s)?'disabled':''}>${icon('Folder')}<span>${esc(pathLabel(s.cwd))}</span><span class="chev">${icon('ChevronDown')}</span></button><button type="button" class="tool" id="session-model" data-action="model-picker" title="此会话模型：${esc(modelName(s.model))}" ${!online||busy(s)?'disabled':''}>${icon('KeyRound')}<span>${esc(modelName(s.model))}</span><span class="chev">${icon('ChevronDown')}</span></button></div>${latest(s)?.status==='running'?button('','stop-task','send','Square','aria-label="停止当前会话任务"'):`<button type="submit" class="send" id="send-message" aria-label="发送任务" ${blocked||!s.draft.trim()?'disabled':''}>${icon('ArrowUp')}</button>`}</div></form><div class="composer-caption">${!online?'连接恢复后再发送，各会话草稿会保留':busy(s)?'当前会话的任务进行中，模型和目录已固定':'模型与目录仅作用于当前会话，任务在云端运行'}</div></div>`;}

  function steps(n) {
    return `<div class="steps" aria-label="初始化步骤">${['连接服务器','配置 Bot','初始化'].map((label,i)=>`${i?'<span class="step-line" aria-hidden="true"></span>':''}<div class="step ${i<n?'done':i===n?'current':''}" ${i===n?'aria-current="step"':''}><i>${i<n?icon('Check'):i+1}</i><span>${label}</span></div>`).join('')}</div>`;
  }
  function wizard(n,body) { return `<div class="page-scroll"><section class="wizard fade-in">${steps(n)}${body}</section></div>`; }

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

  function installPage() {
    const failed=state==='init-error', canceled=state==='init-canceled';
    const displaySteps=installSteps.map((step,i)=>i===1&&reuseInstall?['检查已有运行组件','已安装且版本兼容，直接复用']:step);
    return wizard(2,`<div class="wizard-head"><h2>${canceled?'初始化已取消':failed?'初始化尚未完成':'正在初始化云端 Bot'}</h2><p>${canceled?'已完成的步骤和配置保留，随时可以继续。':failed?'运行组件和配置已保留。处理问题后可继续，无需重装。':'完成后，Bot 将独立运行，不依赖本机保持连接。'}</p></div><div class="setup-summary"><div class="server-avatar">${icon('Server')}</div><div><strong>${esc(config.host)}</strong><small>Linux · ${esc(config.workdir)}</small></div></div><ol class="install-list" aria-live="polite">${displaySteps.map(([label,detail],i)=>`<li class="${i<installStep?'done':i===installStep?(failed?'failed':canceled?'paused':'current'):''}"><span class="install-icon">${i<installStep?icon('Check'):i===installStep?(failed?icon('CircleX'):canceled?icon('Circle'):`<span class="spin">${icon('LoaderCircle')}</span>`):icon('Circle')}</span><div class="install-copy"><strong>${label}</strong>${i===installStep||i<installStep?`<small>${i===installStep&&failed?'当前账号尚未开启退出登录后的驻留权限。':i===installStep&&canceled?'尚未完成，可以继续初始化。':detail}</small>`:''}</div></li>`).join('')}</ol>${failed?`<div class="inline-note error" role="alert">${icon('TriangleAlert')}<p>请联系服务器管理员开启当前账号的常驻权限，再点“重新检测并继续”。云端 Bot 目前尚未启动。</p></div><details class="disclosure"><summary>查看诊断信息</summary><pre>阶段：配置用户级常驻服务\n条件：退出 SSH 登录后仍需保持服务运行\n当前结果：未满足，未进入可用状态\n演示操作：本稿点击重试会模拟修复成功。</pre></details>`:`<details class="disclosure"><summary>查看初始化详情</summary><pre>${displaySteps.slice(0,installStep).map(([label])=>label+'：已完成').join('\n')}\n当前阶段：${installSteps[installStep]?.[0]??'保存连接'}${canceled?'，已暂停':'，尚未完成'}\n常驻验证会断开本次 SSH 后重连\n不会重启服务器</pre></details>`}<div class="wizard-footer">${button(failed||canceled?'返回配置':'取消初始化',failed||canceled?'configure':'cancel-init','ghost',failed||canceled?'ArrowLeft':'')}${canceled?button('继续初始化','resume-init','primary large','Play'):failed?button('重新检测并继续','retry-init','primary large','RefreshCw','id="retry-init"'):button('正在验证…','none','primary large','','disabled')}</div>`);
  }

  function modal(title,body,actions,kind='') {
    return `<div class="modal-layer" data-backdrop="true"><section class="modal ${kind}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal-head"><h2 id="dialog-title">${title}</h2>${button('','close-layer','ghost icon','X','aria-label="关闭弹窗"')}</div>${body}<div class="modal-actions">${actions}</div></section></div>`;
  }
function openLayer(name){const old=document.activeElement;focusReturn=old?.id?'#'+CSS.escape(old.id):old?.dataset.action?'[data-action="'+old.dataset.action+'"]':'#bot-settings';stack.push({layer,focus:focusReturn});layer=name;fixtureAlias=null;if(name==='sync'&&!syncInFlight){syncDraft=new Set(bound?syncCandidates():afterSetupModels);syncPhase='idle';syncError='';}render();}
function closeLayer(){if(layer==='folder'&&picker?.confirming)return;if(syncPhase==='syncing'&&layer==='sync')return;const previous=stack.pop();layer=previous?.layer??null;fixtureAlias=null;render();if(previous?.focus)[...app.querySelectorAll(previous.focus)].find(el=>!el.closest('[inert]')&&el.getClientRects().length)?.focus({preventScroll:true});}
function syncRows(){return localModels.map((m,i)=>{const cloud=cachedModels[m.key];const status=!m.canSync?m.reason:!cloud?'未同步':cloud.revision<m.revision?'有更新':'已同步';return `<li class="model-row ${!m.canSync?'unavailable':''}"><label><input id="sync-model-${i}" type="checkbox" data-sync-model="${m.key}" ${syncDraft.has(m.key)?'checked':''} ${!m.canSync||syncPhase==='syncing'?'disabled':''}><span class="model-copy"><strong>${esc(m.name)}</strong><small>${esc(m.provider)} · ${esc(m.auth)}</small></span></label><span class="model-state ${status==='已同步'?'available':status==='有更新'?'warning':''}">${status}</span></li>`;}).join('');}
function overlay(name){
 if(name==='trust')return modal('确认服务器身份',`<p>首次连接 <strong>${esc(config.host)}</strong>。请核对服务器提供的主机指纹。</p><code class="fingerprint">ED25519<br>SHA256:ExampleHemiCloudFingerprint7K9s<br><span class="muted">交互稿示例指纹</span></code><label class="check-label"><input id="trust-checkbox" type="checkbox">已核对，这是我要连接的服务器</label>`,button('取消','cancel-trust')+button('信任并继续','trust-confirm','primary','','id="trust-confirm" disabled'));
 if(name==='sync')return modal(bound?'同步本机模型':'选择要同步的本机模型',`<p>手动选择本次同步的条目。不会自动上传其他模型或以后修改的配置。</p><ul class="model-rows">${syncRows()}</ul><p class="sync-scope" id="sync-scope">本次${bound?'写入云端':'用于初始化'}：${[...syncDraft].map(key=>local(key)?.name).filter(Boolean).map(esc).join('、')||'未选择模型'}${syncDraft.size?'（接口、型号、API Key）':''}</p>${syncError&&syncError!=='reconciling'?`<div class="inline-note error" role="alert">${icon('CircleX')}<p>${esc(syncError)}</p></div>`:''}${syncPhase==='done'?`<div class="inline-note success" role="status">${icon('CircleCheck')}<p>云端已确认同步结果，所选模型已可在会话中使用。</p></div>`:''}<div class="sync-hint">${icon('Info')}<span>${bound?'所选模型的接口和 API Key 会保存到云服务器。未勾选不会删除已有模型。':'将在初始化时保存所选接口和 API Key，并从云端验证。'}账号登录暂不支持同步到云端。</span></div>`,button(syncPhase==='done'?'完成':'取消','close-layer','ghost','',''+(syncPhase==='syncing'?'disabled':''))+(syncPhase==='done'?'':button(syncPhase==='syncing'?'正在同步…':bound?'同步到 Bot':'用于初始化','commit-sync','primary',syncPhase==='syncing'?'LoaderCircle':'RefreshCw',`id="commit-sync" ${!syncDraft.size||syncPhase==='syncing'||!online?'disabled':''}`)),'sync-modal');
 if(name==='model-picker'){const s=active();return modal('此会话使用的模型',`<p>从 Bot 已同步并验证可用的模型中选择。只影响当前会话。</p><div style="margin-top:var(--sp-16)">${modelChoices().map(m=>{const usable=cachedModels[m.key]?.usable;return `<button type="button" class="model-select-row" data-action="select-session-model" data-model="${m.key}" ${!usable?'disabled':''}><span class="selected">${s?.model===m.key?icon('Check'):''}</span><span class="model-copy"><strong>${esc(m.name)}</strong><small>${esc(m.provider)}${usable?'':` · ${m.canSync?'尚未同步':m.reason}`}</small></span></button>`;}).join('')}</div>`,button('同步本机模型','sync-models','link','RefreshCw'));
 }
 if(name==='folder')return folderDialog();
 if(name==='settings')return `<div class="panel-layer"><section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal-head"><h2 id="dialog-title">Bot 设置</h2>${button('','close-layer','ghost icon','X','aria-label="关闭设置"')}</div><section class="setting-section"><h3>云服务器</h3><dl class="setting-grid"><dt>SSH 地址</dt><dd>${esc(config.host)}</dd><dt>系统</dt><dd>Ubuntu 24.04 · x86_64</dd><dt>连接</dt><dd>${online?'已连接':'连接已断开'}</dd><dt>常驻服务</dt><dd>${online?(enabled?'已启用':'已停止'):'状态未知'}</dd></dl></section><section class="setting-section"><h3>Bot 模型</h3><p class="help">${Object.keys(cachedModels).length} 个已同步模型，供所有会话选择。</p>${button('同步本机模型','sync-models','link','RefreshCw','id="settings-sync-models" style="margin-top:var(--sp-12)" '+(!online?'disabled':''))}</section><section class="setting-section"><h3>云端默认空间</h3><code>${esc(config.workdir)}</code><p class="help">新会话从这里开始；运行目录在各会话输入框中选择。</p></section><section class="setting-section"><h3>连接与运行</h3>${button(enabled?'停止 Bot':'启动 Bot',enabled?'stop-bot':'start-bot','setting-action',enabled?'Power':'Play')}${button('断开连接','disconnect','setting-action','Unplug')}</section>${button('移除连接','remove','setting-action danger','Link2')}<p class="help">只解除本机绑定，云端会话、模型密钥和工作文件保留。</p></section></div>`;
 if(name==='stop')return modal('停止云端 Bot？','<p>正在运行或等待确认的任务会中断，常驻与开机自动启动会关闭。会话、已同步模型和云端文件保留。</p>',button('取消','close-layer')+button('停止 Bot','confirm-stop','primary','','id="confirm-stop"'));
 if(name==='remove')return modal('移除本机连接？','<p>云端 Bot 的会话、模型密钥和文件仍会保留。</p><label class="check-label"><input id="stop-before-remove" type="checkbox" checked>先停止 Bot，再移除连接</label>',button('取消','close-layer')+button('停止并移除','confirm-remove','primary','','id="confirm-remove"'));
 if(name==='cancel-init')return modal('取消这次初始化？','<p>已安装的组件和已经保存的配置会保留，下次重新检测后继续。</p>',button('继续初始化','resume-init')+button('取消初始化','confirm-cancel-init','primary'));
 if(name==='file'){const run=visibleSessions().flatMap(s=>s.runs).find(r=>r.id===picker?.runId);return modal('change-summary.md',`<p class="help">本次任务的云端路径</p><code class="fingerprint">${esc(config.host)}<br>${esc(run?.artifactPath??'')}</code>${!online?'<p class="help" id="download-offline-reason">连接恢复后才能读取和下载云端文件。</p>':''}${online?'<div class="file-preview">项目变更摘要\n\n文件交付、任务状态和相关说明已整理。\n\n这是交互稿的演示文件。</div>':''}`,button('关闭','close-layer')+button('下载文件','download','primary','Download',!online?'disabled aria-describedby="download-offline-reason"':''));}
 return '';
}
function folderDialog(){
 const p=picker,entries=p.entries??[],pending=normalizePath(p.input)!==p.path,showPathHint=Boolean(p.addressEdited&&pending&&!p.loading);
 const list=p.loading?`<div class="folder-feedback" role="status"><span class="spin">${icon('LoaderCircle')}</span><p>正在读取服务器文件夹…</p></div>`:p.error?`<div class="folder-feedback" role="alert">${icon('CircleX')}<p>${esc(p.error)}</p>${p.errorKind==='read'?button('重试','folder-retry','secondary','','id="folder-retry"'):''}</div>`:entries.length?entries.map(name=>`<button type="button" class="folder-row" data-action="folder-enter" data-path="${esc((p.path==='/'?'':p.path)+'/'+name)}" ${p.confirming?'disabled':''}>${icon('Folder')}<span>${esc(name)}</span>${icon('ChevronRight')}</button>`).join(''):'<p class="folder-empty">此文件夹没有子文件夹</p>';
 return modal('选择云端文件夹',`<div class="folder-host">${icon('Server')}${esc(config.host)}</div><div class="folder-address">${button('','folder-up','secondary icon','ArrowUp','aria-label="上级目录" '+(p.path==='/'||p.confirming?'disabled':''))}<label class="sr-only" for="cloud-path">云端文件夹路径</label><input class="input mono" id="cloud-path" value="${esc(p.input)}" title="${esc(p.input)}" spellcheck="false" ${p.confirming?'disabled':''}>${button('前往','folder-go','secondary','','id="folder-go" '+(p.confirming?'disabled':''))}</div><p class="help" id="path-validation-note" ${!showPathHint?'hidden':''}>按回车或点击“前往”打开这个路径。</p><div class="folder-shortcuts">${button('默认空间','folder-default','ghost','Home',p.confirming?'disabled':'')}${button('主目录','folder-home','ghost','Folder',p.confirming?'disabled':'')}${recentFolders.length?`<details class="folder-recent"><summary>最近使用</summary><div>${recentFolders.map(path=>button(esc(basename(path)),'folder-enter','ghost','Folder',`data-path="${esc(path)}" title="${esc(path)}" ${p.confirming?'disabled':''}`)).join('')}</div></details>`:''}</div><div class="folder-list" aria-label="云端目录列表" aria-busy="${Boolean(p.loading)}">${list}</div>${p.confirming?'<p class="help" role="status">等待云端确认所选目录…</p>':''}`,button('取消','close-layer','ghost','',p.confirming?'disabled':'')+button(p.confirming?'云端确认中…':'使用此文件夹','commit-folder','primary','FolderOpen',`id="commit-folder" ${p.error||pending||p.loading||!online||p.confirming?'disabled':''}`),'folder-modal');
}
function commitFolder(){
 if(!online||!picker||picker.error||picker.loading||picker.confirming||normalizePath(picker.input)!==picker.path)return;
 const target=picker;target.confirming=true;render();folderTimer=setTimeout(()=>{target.confirming=false;if(!online||picker!==target||layer!=='folder')return;if(target.purpose==='default'){config.workdir=target.path;recentFolders=[target.path,...recentFolders.filter(path=>path!==target.path)].slice(0,4);}else{const s=sessions.find(s=>s.id===target.sessionId);if(!s||busy(s)){render();return toast('原会话状态已变化，请重新选择目录');}s.cwd=target.path;s.notice='';recentFolders=[target.path,...recentFolders.filter(path=>path!==target.path)].slice(0,4);setCache();}closeLayer();},350);
}
function beginFolder(purpose){if(!online)return toast('请先恢复连接，再浏览云端文件夹');const s=active();if(purpose==='session'&&busy(s))return toast('任务结束后可修改此会话目录');const path=purpose==='default'?config.workdir:s.cwd;picker={purpose,sessionId:s?.id,path,input:path,entries:[],loading:true,request:0,addressEdited:false,error:''};openLayer('folder');void navigateFolder(path);}
// Demo transport only. Production must obtain this level of folders from the bound Host/SSH service.
async function readDemoCloudFolders(path){
 await new Promise(resolve=>setTimeout(resolve,200));
 if(path==='/root')throw Object.assign(new Error('无法访问 /root：当前云端账号没有权限。'),{kind:'permission'});
 if(!Object.hasOwn(tree,path))throw Object.assign(new Error('找不到这个云端文件夹，请检查路径。'),{kind:'missing'});
 return [...tree[path]];
}
async function navigateFolder(path){
 const target=picker;if(!target||target.confirming||!online)return;
 const normalized=normalizePath(path),request=(target.request??0)+1;target.request=request;target.input=normalized;target.requestedPath=normalized;target.loading=true;target.addressEdited=false;target.error='';target.errorKind='';target.entries=[];render();const loadingFocus=document.activeElement;
 try{const entries=await readDemoCloudFolders(normalized);if(picker!==target||layer!=='folder'||target.request!==request||!online)return;target.path=normalized;target.entries=entries;}
 catch(error){if(picker!==target||layer!=='folder'||target.request!==request||!online)return;target.error=error.message;target.errorKind=error.kind??'read';}
 finally{if(picker===target&&layer==='folder'&&target.request===request&&online){const restoreFocus=document.activeElement===loadingFocus;target.loading=false;render();if(restoreFocus)(target.error?$('#cloud-path'):$('.folder-row:not(:disabled)')??$('#cloud-path'))?.focus({preventScroll:true});}}
}
function newSession(){if(!online||!enabled)return toast('连接并启动 Bot 后可以新建会话');const s=blankSession('s'+nextId++);sessions.unshift(s);activeId=s.id;drawer=false;layer=null;fixtureAlias=null;setCache();render();$('#message')?.focus();}
function switchSession(id){if(!visibleSessions().some(s=>s.id===id))return;activeId=id;drawer=false;layer=null;stack=[];fixtureAlias=null;render();}
function allRuns(){return sessions.flatMap(s=>s.runs.map(run=>({session:s,run})));}
function schedule(){if(!enabled||allRuns().some(({run})=>['running','approval'].includes(run.status)))return;const next=allRuns().filter(({run})=>run.status==='queued').sort((a,b)=>a.run.order-b.run.order)[0];if(!next)return;next.run.status='running';if(online){setCache();render();}const timer=setTimeout(()=>{queueTimers.delete(next.run.id);if(!enabled||next.run.status!=='running')return;next.run.status=/推送|同步已有提交/.test(next.run.text)?'approval':'complete';if(online){setCache();render();}schedule();},1800);queueTimers.set(next.run.id,timer);}
function send(){const s=active();if(!s?.draft.trim()||!online||!enabled||busy(s))return;const model=remoteModels[s.model];if(!model?.usable)return toast('此会话模型不可用，请先同步或重新选择');const run={id:'r'+nextRun,order:nextRun++,text:s.draft.trim(),model:s.model,revision:model.revision,modelName:model.name,cwd:s.cwd,cwdLabel:pathLabel(s.cwd),status:'queued',result:'summary',artifactPath:s.cwd+'/change-summary.md'};s.runs.push(run);if(s.title==='新会话')s.title=run.text.slice(0,14);s.draft='';s.notice='';fixtureAlias=null;setCache();schedule();render();}
function stopCurrent(){if(!online)return toast('连接中断，无法确认停止结果');const run=latest(active());if(!run||!['running','queued','approval'].includes(run.status))return;clearTimeout(queueTimers.get(run.id));queueTimers.delete(run.id);run.status='stopped';setCache();schedule();render();}
function setConnection(value){
 if(!value){setCache();online=false;if(syncInFlight)syncPhase='unknown';fixtureAlias=null;layer=null;stack=[];render();return;}
 online=true;setCache();if(syncPhase==='unknown'){if(syncInFlight){syncPhase='syncing';syncError='reconciling';}else{syncPhase='done';syncError='';syncReconciled=true;}}fixtureAlias=null;render();
}
function syncModels(){if(!online||syncInFlight)return;const keys=[...syncDraft].filter(key=>local(key)?.canSync);if(!keys.length)return;if(!bound){afterSetupModels=new Set(keys);if(!keys.includes(config.model))config.model=keys[0];closeLayer();return;}syncPhase='syncing';syncError='';syncInFlight=true;syncReconciled=false;render();syncTimer=setTimeout(()=>{for(const key of keys)remoteModels[key]=cloudModel(key);syncInFlight=false;if(online){cachedModels=copy(remoteModels);syncReconciled=layer!=='sync';syncPhase='done';syncError='';}else{syncPhase='unknown';syncError='连接中断，结果待核对。重新连接后查看云端状态。';}render();},800);}
function startInit(from=0){clearTimeout(initTimer);reuseInstall=installed;installStep=from;initRunning=true;layer=null;stack=[];state='initializing';fixtureAlias=null;lastBotPage=state;render();const advance=()=>{if(!initRunning)return;installStep++;if(installStep>=2)installed=true;if(installStep>=installSteps.length){initRunning=false;bound=true;for(const key of afterSetupModels)remoteModels[key]=cloudModel(key);cachedModels=copy(remoteModels);if(state==='home'){lastBotPage='initialized';}else go('initialized');return;}if(state==='initializing')render();initTimer=setTimeout(advance,600);};initTimer=setTimeout(advance,600);}
function enterBot(){if(!sessions.length){const s=blankSession('s1');sessions.push(s);activeId=s.id;}bound=true;enabled=true;setCache();go('bot');}
function stopBot(){if(!online)return toast('连接中断，无法确认云端停止');enabled=false;for(const {run}of allRuns())if(['running','approval'].includes(run.status)){clearTimeout(queueTimers.get(run.id));queueTimers.delete(run.id);run.status='stopped';}setCache();layer=null;stack=[];fixtureAlias=null;render();}
function action(action,el){
 fixtureAlias=null;
 if(action==='create')go('connect');
 else if(action==='back-connect')go('connect');
 else if(action==='welcome')go('welcome');
 else if(action==='configure')go('configure');
 else if(action==='trust-confirm'&&$('#trust-checkbox')?.checked)go('configure');
 else if(action==='cancel-trust'){layer=null;stack=[];go('connect');}
 else if(action==='initialize')startInit();
 else if(action==='retry-init')startInit(3);
 else if(action==='resume-init')startInit(installStep);
 else if(action==='cancel-init'){clearTimeout(initTimer);initRunning=false;openLayer('cancel-init');}
 else if(action==='confirm-cancel-init'){initRunning=false;layer=null;go('init-canceled');}
 else if(action==='enter-bot')enterBot();
 else if(action==='home'){lastBotPage=state==='connecting'?'connect':state;go('home');}
 else if(action==='bot')go(bound?(sessions.length?'bot':'initialized'):lastBotPage);
 else if(action==='new-session')newSession();
 else if(action==='switch-session')switchSession(el.dataset.session);
 else if(action==='toggle-drawer'){drawer=true;render();}
 else if(action==='close-drawer'){drawer=false;render();$('#session-drawer-trigger')?.focus();}
 else if(action==='sync-models'){if(!online)return toast('连接恢复后可同步模型');openLayer('sync');}
 else if(action==='commit-sync')syncModels();
 else if(action==='dismiss-sync'){syncReconciled=false;render();}
 else if(action==='model-picker'){if(!online||busy(active()))return;openLayer('model-picker');}
 else if(action==='select-session-model'){if(!online||busy(active())||!cachedModels[el.dataset.model]?.usable)return;active().model=el.dataset.model;active().notice='此会话后续任务使用 '+modelName(active().model);setCache();closeLayer();}
 else if(action==='choose-default-folder')beginFolder('default');
 else if(action==='choose-session-folder')beginFolder('session');
 else if(action==='folder-enter')void navigateFolder(el.dataset.path);
 else if(action==='folder-retry')void navigateFolder(picker.requestedPath??picker.input);
 else if(action==='folder-go')navigateFolder($('#cloud-path').value);
 else if(action==='folder-up'){const parts=(picker.requestedPath??picker.path).split('/').filter(Boolean);parts.pop();navigateFolder('/'+parts.join('/'));}
 else if(action==='folder-default')navigateFolder(config.workdir);
 else if(action==='folder-home')navigateFolder('/home/ubuntu');
 else if(action==='commit-folder')commitFolder();
 else if(action==='example'){active().draft='检查这个目录的最近改动，整理一份摘要。';render();$('#message')?.focus();}
 else if(action==='settings')openLayer('settings');
 else if(action==='disconnect')setConnection(false);
 else if(action==='reconnect'){if(connectionBusy)return;connectionBusy=true;el.disabled=true;el.textContent='正在同步状态…';connectTimer=setTimeout(()=>{connectionBusy=false;setConnection(true);toast('已恢复云端模型和各会话状态');},700);}
 else if(action==='stop-task')stopCurrent();
 else if(action==='approve'||action==='deny'){if(!online)return;const run=allRuns().find(({run})=>run.id===el.dataset.run)?.run;if(run?.status!=='approval')return;run.status='complete';run.result=action==='deny'?'denied':'pushed';setCache();schedule();render();}
 else if(action==='stop-bot')openLayer('stop');
 else if(action==='confirm-stop')stopBot();
 else if(action==='start-bot'){if(!online)return;enabled=true;setCache();schedule();layer=null;render();}
 else if(action==='remove')openLayer('remove');
 else if(action==='confirm-remove'){if($('#stop-before-remove').checked&&!online)return toast('请先恢复连接，确认停止后再移除');resetData();render();}
 else if(action==='close-layer'){const was=layer;closeLayer();if(was==='cancel-init')startInit(installStep);}
 else if(action==='file'){picker={runId:el.dataset.run};openLayer('file');}
 else if(action==='download'){if(!online)return toast('连接恢复后才能下载云端文件');const run=allRuns().find(({run})=>run.id===picker.runId)?.run;const blob=new Blob(['# 示例项目变更摘要\n\n云端目录：'+run?.cwd+'\n\n此文件由交互稿生成，全部为演示数据。\n'],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='示例-change-summary.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
app.addEventListener('click',e=>{const target=e.target.closest('[data-action]');if(target&&!target.disabled)action(target.dataset.action,target);});
app.addEventListener('submit',e=>{e.preventDefault();if(e.target.id==='connection-form'){if(!config.host.trim())return;go('connecting');connectTimer=setTimeout(()=>{if(config.host.includes('fail'))go('connect-error');else openLayer('trust');},650);}if(e.target.id==='message-form')send();});
app.addEventListener('input',e=>{if(e.target.id==='server'){config.host=e.target.value;$('#connect-submit').disabled=!config.host.trim();}if(e.target.id==='message'){const s=active();s.draft=e.target.value;if(!online){const c=cachedSessions.find(c=>c.id===s.id);if(c)c.draft=s.draft;}const send=$('#send-message');if(send)send.disabled=!s.draft.trim()||!online||!enabled||busy(s);}if(e.target.id==='cloud-path'){picker.input=e.target.value;picker.addressEdited=true;e.target.title=picker.input;const pending=normalizePath(picker.input)!==picker.path;$('#commit-folder').disabled=pending||Boolean(picker.error)||Boolean(picker.loading)||!online||Boolean(picker.confirming);$('#path-validation-note').hidden=!pending||Boolean(picker.loading);}});
app.addEventListener('change',e=>{if(e.target.name==='auth'){authMode=e.target.value;render();}if(e.target.id==='trust-checkbox')$('#trust-confirm').disabled=!e.target.checked;if(e.target.id==='default-model')config.model=e.target.value;if(e.target.dataset.syncModel){if(e.target.checked)syncDraft.add(e.target.dataset.syncModel);else syncDraft.delete(e.target.dataset.syncModel);$('#commit-sync').disabled=!syncDraft.size||!online;$('#sync-scope').textContent='本次'+(bound?'写入云端':'用于初始化')+'：'+([...syncDraft].map(key=>local(key)?.name).filter(Boolean).join('、')||'未选择模型')+(syncDraft.size?'（接口、型号、API Key）':'');}if(e.target.id==='stop-before-remove')$('#confirm-remove').textContent=e.target.checked?'停止并移除':'仅移除连接';});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(layer||drawer)){e.preventDefault();if(drawer){drawer=false;render();$('#session-drawer-trigger')?.focus();}else{const was=layer;if(was==='trust'){layer=null;go('connect');}else{closeLayer();if(was==='cancel-init')startInit(installStep);}}return;}if((layer||drawer)&&e.key==='Tab'){const d=app.querySelector('[role="dialog"]');const elements=[...d.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(x=>x.getClientRects().length);const first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}if(e.target.id==='message'&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}if(e.target.id==='cloud-path'&&e.key==='Enter'){e.preventDefault();navigateFolder(e.target.value);}});
$('#scene-picker').innerHTML=scenes.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');$('#scene-picker').addEventListener('change',e=>showScene(e.target.value));$('#reset-prototype').addEventListener('click',()=>showScene('welcome'));
globalThis.hemiBotPrototype={showScene,setConnection,snapshot:()=>({state:current(),page:state,layer,online,enabled,bound,activeId,defaultModel:config.model,defaultSpace:config.workdir,sessions:copy(visibleSessions()),serverSessions:copy(sessions),models:copy(cachedModels),remoteModels:copy(remoteModels),syncPhase,syncReconciled,folder:picker?.purpose?copy(picker):null,hasRealNetwork:false})};
globalThis.hemiWorkspacePrototype={snapshot:()=>globalThis.hemiBotPrototype.snapshot()};
showScene(scenes.some(([key])=>key===params.get('state'))?params.get('state'):'welcome');
})();
