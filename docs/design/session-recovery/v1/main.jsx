import React,{useEffect,useId,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowUp,ArrowUpRight,Check,CheckCheck,ChevronDown,ChevronRight,CircleAlert,FileText,Folder,LoaderCircle,Pause,Play,Plus,RefreshCw,ShieldCheck,Square,WifiOff,X} from 'lucide-react';
import '../../../../src/renderer/src/tokens.css';
import './style.css';
import {RECOVERY_WINDOW_MS,retryDelayMs} from './recovery-policy.mjs';

const scenes=[['waiting','短暂中断'],['backoff','持续失败'],['offline','网络离线'],['exhausted','30 分钟到期'],['auth','需要修复'],['uncertain','结果待确认'],['recovered','恢复成功']];
const samples=[
  ['waiting','等待重试','失败越久，间隔越长，后期每分钟尝试一次。'],
  ['connecting','正在恢复','只显示当前尝试次数和停止操作。'],
  ['offline','网络离线','离线时暂停请求，30 分钟期限继续计时。'],
  ['exhausted','30 分钟到期','到期停止自动请求，用户可以重新开始。'],
  ['uncertain','结果待确认','先核对已发出的操作，不自动重做。'],
  ['recovered','恢复成功','继续当前回复，短暂反馈后折叠为恢复记录。'],
];
const copy={
 waiting:{title:'连接中断，正在自动恢复',description:'已保留当前进度，恢复后继续。',icon:RefreshCw,tone:'active'},
 connecting:{title:'正在重新连接…',description:'按逐渐降低的频率尝试，当前进度已保留。',icon:LoaderCircle,tone:'active'},
 syncing:{title:'已连接，正在核对任务进度…',description:'确认已完成的步骤后继续。',icon:ShieldCheck,tone:'active'},
 offline:{title:'网络已断开，等待网络恢复',description:'当前进度已保留；联网后自动尝试恢复。',icon:WifiOff,tone:'neutral'},
 exhausted:{title:'自动恢复已到期',description:'已持续尝试 30 分钟，当前进度已保留。可以重新开始一个恢复周期。',icon:CircleAlert,tone:'warning'},
 auth:{title:'模型密钥已失效',description:'更新密钥后，可以继续这轮对话。',icon:CircleAlert,tone:'error'},
 uncertain:{title:'连接已恢复，需要核对操作结果',description:'“同步提交”已发出，尚未收到执行结果。',icon:ShieldCheck,tone:'warning'},
 stopped:{title:'已停止自动恢复',description:'当前进度已保留，可以稍后继续。',icon:Pause,tone:'neutral'},
 recovered:{title:'已恢复，继续处理',description:'已核对进度，接着刚才的步骤继续。',icon:CheckCheck,tone:'success'},
};
function Action({children,onClick,primary=false,disabled=false,...rest}){return <button type="button" className={'recovery-button'+(primary?' primary':'')} onClick={onClick} disabled={disabled} {...rest}>{children}</button>;}
function RecoveryNotice({state='waiting',seconds=1,attempt=1,compact=false,onAction=()=>{},history=[],elapsedMs=0}){
 const c=copy[state],Icon=c.icon,[expanded,setExpanded]=useState(false),detailId=useId();
 const titles={waiting:'正在重连',connecting:'正在重连',syncing:'正在核对进度',offline:'等待网络恢复',exhausted:'自动恢复已到期',auth:'密钥已失效',uncertain:'待核对操作结果',stopped:'已停止重连',recovered:'已恢复'};
 useEffect(()=>setExpanded(false),[state]);
 return <div className={'recovery-notice '+c.tone+(compact?' sample-notice':'')} data-state={state}>
  <div className="recovery-row">
   <Icon className={'notice-icon'+(['connecting','syncing'].includes(state)?' spinning':'')} size={14} strokeWidth={1.75} aria-hidden="true"/>
   <p className="notice-title" role="status">{titles[state]}</p>
   {state==='waiting'&&<span className="countdown" aria-label={`${seconds} 秒后第 ${attempt} 次重试`}>{seconds} 秒后重试</span>}
   {state==='connecting'&&<span className="countdown">第 {attempt} 次</span>}

   <div className="notice-actions">
    {['waiting','connecting','syncing'].includes(state)&&<Action aria-label="停止恢复" onClick={()=>onAction('stop')}>停止</Action>}
    {state==='offline'&&<Action aria-label="停止等待" onClick={()=>onAction('stop')}>停止</Action>}
    {state==='exhausted'&&<Action primary aria-label="重新开始恢复" onClick={()=>onAction('retry')}>重新开始</Action>}
    {state==='auth'&&<Action primary aria-label="检查模型设置" onClick={()=>onAction('settings')}>检查设置</Action>}
    {state==='uncertain'&&<Action primary aria-label="核对操作结果" onClick={()=>onAction('verify')}>核对结果</Action>}
    {state==='stopped'&&<Action primary onClick={()=>onAction('retry')}>继续尝试</Action>}
   </div>
   <button type="button" className="details-toggle" aria-label="恢复详情" aria-expanded={expanded} aria-controls={detailId} onClick={()=>setExpanded(value=>!value)}><ChevronDown size={13} aria-hidden="true"/></button>
  </div>
  <div className="recovery-details" id={detailId} hidden={!expanded}>
      <p className="notice-description recovery-budget">已重试 {state==='waiting'?Math.max(0,attempt-1):attempt} 次 · 剩余 {Math.ceil(Math.max(0,RECOVERY_WINDOW_MS-elapsedMs)/60000)} 分钟</p>
   <div className="detail-actions">
    {state==='waiting'&&<Action onClick={()=>onAction('retry')}>立即重试</Action>}
    {state==='offline'&&<Action onClick={()=>onAction('check')}>检查连接</Action>}
    {['exhausted','stopped'].includes(state)&&<Action onClick={()=>onAction('model')}>更换模型</Action>}
    {state==='uncertain'&&<Action onClick={()=>onAction('stop')}>暂不继续</Action>}
   </div>
   <ol aria-label="恢复记录"><li><time>14:32:08</time><span>模型连接中断 · HTTP 503</span></li>{history.map((item,index)=><li key={index}><time>+{item.time}s</time><span>{item.text}</span></li>)}<li><time>当前</time><span>{state==='waiting'?`等待第 ${attempt} 次重试`:c.title}</span></li></ol>
   <code>Service unavailable · 演示诊断信息</code>
  </div>
 </div>;
}
function App(){
 const selectedScene=new URLSearchParams(location.search).get('state')||'waiting';
 const initial=selectedScene==='backoff'?'waiting':selectedScene;
 const [state,setState]=useState(copy[initial]?initial:'waiting'),[scene,setScene]=useState(selectedScene==='backoff'?'backoff':copy[initial]?initial:'waiting'),[seconds,setSeconds]=useState(selectedScene==='backoff'?60:1),[attempt,setAttempt]=useState(selectedScene==='backoff'?12:selectedScene==='exhausted'?34:1),[playing,setPlaying]=useState(false),[settled,setSettled]=useState(false),[history,setHistory]=useState([]),[draft,setDraft]=useState('完成后再给我一份简短摘要'),[panel,setPanel]=useState(null),[elapsedMs,setElapsedMs]=useState(selectedScene==='exhausted'?RECOVERY_WINDOW_MS:selectedScene==='backoff'?12*60000:0),[online,setOnline]=useState(false),[verified,setVerified]=useState(false),[feedback,setFeedback]=useState(''),[selectedConfig,setSelectedConfig]=useState('');
 const timer=useRef(null),generation=useRef(0),start=useRef(Date.now()),returnFocus=useRef(null);
 const busy=['waiting','connecting','syncing','offline','uncertain'].includes(state);
 function clear(){generation.current++;clearTimeout(timer.current);setPlaying(false);}
 function pick(value){clear();setScene(value);setState(value==='backoff'?'waiting':value);setSeconds(value==='backoff'?retryDelayMs(12)/1000:1);setAttempt(value==='exhausted'?34:value==='backoff'?12:1);setHistory([]);setSettled(false);setPanel(null);setElapsedMs(value==='exhausted'?RECOVERY_WINDOW_MS:value==='backoff'?12*60000:0);setOnline(false);setVerified(false);setFeedback('');const url=new URL(location.href);url.searchParams.set('state',value);window.history.replaceState(null,'',url);}
 function log(text){setHistory(h=>[...h,{time:Math.round((Date.now()-start.current)/1000),text}]);}
 function schedule(fn,delay){const version=generation.current;timer.current=setTimeout(()=>{if(version===generation.current)fn();},delay);}
 function sync(){setState('syncing');log('连接恢复，核对现有任务');schedule(()=>{setState('recovered');setPlaying(false);log('进度核对完成，继续当前回复');schedule(()=>setSettled(true),3000);},1100);}
 function connect(number=attempt,{restart=false}={}){clear();if(restart)setElapsedMs(0);setAttempt(number);setState('connecting');setSettled(false);setPlaying(true);log(`第 ${number} 次连接请求`);schedule(()=>sync(),1500);}
 function play(){clear();setElapsedMs(0);start.current=Date.now();setScene('waiting');setState('waiting');setSeconds(1);setAttempt(1);setHistory([]);setSettled(false);setPlaying(true);let remaining=1;const tick=()=>{remaining--;if(remaining>0){setSeconds(remaining);schedule(tick,1000);}else connect(1);};schedule(tick,1000);}
 function action(value){
  if(value==='stop'){clear();setState('stopped');log('用户停止恢复');return;}
  if(value==='retry'){connect(state==='waiting'?attempt:1,{restart:elapsedMs>=RECOVERY_WINDOW_MS});return;}
  if(value==='check'){if(online){clear();setPlaying(true);sync();}else{setFeedback('仍未检测到网络连接');log('检查连接：网络仍离线');}return;}
  if(value==='settings'||value==='model'){returnFocus.current=document.activeElement;clear();setPanel(value);return;}
  if(value==='verify'){returnFocus.current=document.activeElement;clear();setPanel('verify');return;}
 }
 function sampleAction(key,value){pick(key==='connecting'?'waiting':key);if(key==='waiting')setElapsedMs(12*60000);document.querySelector('.conversation-fragment')?.scrollIntoView({behavior:'instant',block:'center'});if(value==='retry')connect(key==='waiting'?12:1,{restart:key==='exhausted'});else if(value==='check')setFeedback('仍未检测到网络连接');else action(value);}
 useEffect(()=>()=>{generation.current++;clearTimeout(timer.current);},[]);
 useEffect(()=>{if(!panel)return;setSelectedConfig('');const previous=returnFocus.current;const onKey=e=>{if(e.key==='Escape'){setPanel(null);return;}if(e.key!=='Tab')return;const items=[...document.querySelectorAll('.demo-dialog button:not(:disabled),.demo-dialog select')];if(!items.length)return;const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}};document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);if(previous?.isConnected)previous.focus();else document.querySelector('.scenario-tabs button[aria-pressed=true]')?.focus();};},[panel]);
 const showResult=state==='recovered';
 return <main className="design-page">
  <header className="design-heading"><div className="brand"><span className="brand-dot"/>Hemi <span className="design-divider">/</span><span>会话自动恢复</span></div><span className="review-label">精简版 · 演示数据</span></header>
  <section className="intro"><button className="play-button" type="button" onClick={play} disabled={playing}><Play size={14}/>{playing?'正在演示恢复过程':'播放恢复过程'}</button></section>
  <div className="scenario-tabs" role="group" aria-label="恢复场景">{scenes.map(([key,label])=><button type="button" key={key} aria-pressed={scene===key} onClick={()=>pick(key)}>{label}</button>)}</div>
  {scene==='offline'&&<label className="online-toggle"><input type="checkbox" checked={online} onChange={e=>{setOnline(e.target.checked);setFeedback('');if(e.target.checked){clear();setPlaying(true);sync();}}}/>模拟网络恢复</label>}
  <section className="main-grid">
   <div className="conversation-fragment" aria-label="会话局部交互稿">
    <div className="fragment-header"><span><Folder size={14}/>Hemi <ChevronRight size={12}/> 整理版本更新</span><span className="fragment-status">{busy?'恢复中':showResult?'继续处理中':'已暂停'}</span></div>
    <div className="transcript">
     <div className="user-message">整理这次更新的改动，生成一份发布说明。</div>
     <div className="assistant-message"><p>我已经检查了最近的提交，正在整理发布说明。</p><div className="completed-step"><Check size={13}/><FileText size={13}/>已读取 12 条提交记录<span>已完成</span></div><p className="partial-reply">本次更新主要包含会话体验和文件预览的改进。</p>
      {showResult&&<p className="continued-reply">接下来会把这些改动按功能整理，并补充使用说明。</p>}
      {settled?<details className="settled-record"><summary><CheckCheck size={14}/>恢复记录<ChevronDown size={12}/></summary><p>自动恢复 {attempt} 次，已核对任务进度。</p></details>:<RecoveryNotice state={state} seconds={seconds} attempt={attempt} details history={history} elapsedMs={elapsedMs} onAction={action}/>}
     </div>
    </div>
    <div className="composer-area"><div className="composer"><textarea aria-label="消息草稿" value={draft} onChange={e=>setDraft(e.target.value)}/><div className="composer-toolbar"><span><Plus size={16}/><span className="model-label">当前模型<ChevronDown size={11}/></span></span><button type="button" className="send-button" aria-label="发送消息" disabled={busy||showResult||!draft.trim()} onClick={()=>{setFeedback('演示：草稿可正常发送；已停止旧任务恢复。');setDraft('');}}><ArrowUp size={16}/></button></div></div>{busy?<p className="composer-hint">停止重连后可发送</p>:null}</div>
   </div>

  </section>
  {feedback&&<p className="feedback" role="status">{feedback}</p>}
  <section className="component-section"><div className="section-title"><h2>局部状态</h2></div><div className="component-grid">{samples.map(([key,title,description])=><article className="sample" key={key}><div className="sample-heading"><h3>{title}</h3><span>{key==='waiting'?'自动':key==='exhausted'||key==='uncertain'?'需要操作':'状态反馈'}</span></div><RecoveryNotice state={key} seconds={60} attempt={key==='waiting'?12:key==='exhausted'?34:1} elapsedMs={key==='exhausted'?RECOVERY_WINDOW_MS:key==='waiting'?12*60000:0} compact onAction={value=>sampleAction(key,value)}/></article>)}</div></section>

  {panel&&<div className="dialog-scrim" onClick={()=>setPanel(null)}><section className="demo-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={e=>e.stopPropagation()}><header><h2 id="dialog-title">{panel==='verify'?'核对操作结果':panel==='settings'?'检查模型设置':'更换模型'}</h2><button className="close-button" type="button" aria-label="关闭" autoFocus onClick={()=>setPanel(null)}><X size={16}/></button></header>{panel==='verify'?<><p>上次已发出“同步提交”，连接中断时没有收到结果。</p><div className="operation-record" data-verified={verified}><ShieldCheck size={16}/><div><strong>{verified?'已确认同步完成':'等待核对远端提交记录'}</strong><p>{verified?'远端提交与本地一致，可以继续后续步骤。':'核对期间暂停后续步骤，避免重复同步。'}</p></div></div><div className="dialog-actions"><Action onClick={()=>setPanel(null)}>暂不继续</Action><Action primary onClick={()=>{if(verified){setPanel(null);connect(1);}else setVerified(true);}}>{verified?'确认并继续':'查询执行结果'}</Action></div></>:<><p>{panel==='settings'?'当前模型的访问验证失败。这里演示修复后的返回路径。':'新的模型只用于接下来的恢复请求，已有步骤和草稿会保留。'}</p><label className="model-field">{panel==='settings'?'密钥状态':'可用模型'}<select aria-label={panel==='settings'?'密钥状态':'可用模型'} value={selectedConfig} onChange={e=>setSelectedConfig(e.target.value)}><option value="" disabled>选择可用配置</option><option value={panel==='settings'?'invalid':'current'}>{panel==='settings'?'当前密钥已失效':'当前模型'}</option><option value="available">{panel==='settings'?'已更新为有效密钥（演示）':'备用模型（演示）'}</option></select></label><div className="dialog-actions"><Action onClick={()=>setPanel(null)}>取消</Action><Action primary disabled={selectedConfig!=='available'} onClick={()=>{setPanel(null);connect(1,{restart:elapsedMs>=RECOVERY_WINDOW_MS});}}>使用此配置继续</Action></div></>}<p className="dialog-footnote">交互路径演示，不修改真实设置或执行实际操作。</p></section></div>}
 </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
