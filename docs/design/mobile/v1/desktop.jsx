import {useEffect,useMemo,useReducer,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft,ArrowUp,Check,ChevronRight,Cloud,Folder,Laptop,MessageSquare,Plus,QrCode,Settings,ShieldCheck,Smartphone,WifiOff,X} from 'lucide-react';
import {ConversationFlow} from '@hemi/conversation-flow';
import {createConversationActionHandler,createConversationPresenter} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import {createPrototypeSession} from './session';
import {fileText} from './data';
import {PairingPanel} from './pairing';
import {comparisonCode,createPairingDemo,pairingDemoReducer} from './pairing-demo';
import '@hemi/conversation-flow/styles.css';
import './style.css';
import '../../../../src/renderer/src/tokens.css';
import '../../../../src/renderer/src/windows/bot/styles.css';
import './desktop.css';

const cases=[['settings','设置入口'],['pair-share','生成配对码'],['request','收到连接请求'],['pair-confirm','核对新设备'],['devices','设备管理'],['offline','连接中断'],['unsupported','旧 Bot 未启用'],['limited','无管理权限']];
const requested=new URL(location.href).searchParams.get('scene');
const initialScene=cases.some(([id])=>id===requested)?requested:'settings';
const initialPanel=scene=>scene==='pair-share'||scene==='pair-confirm'?'pairing':scene==='devices'?'devices':scene==='request'?null:'settings';
const success=()=>({ok:true,value:undefined});

export function DesktopDialog({title,children,footer,className='',onClose}){
  const node=useRef(null);
  useEffect(()=>{const before=document.activeElement;node.current?.focus();return()=>{requestAnimationFrame(()=>{if(before?.isConnected&&!before.closest('[inert]')&&!document.querySelector('.pc-modal'))before.focus({preventScroll:true});});};},[]);
  const keyboard=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key!=='Tab')return;
    const targets=[...node.current.querySelectorAll('button:not(:disabled),input,textarea,[tabindex="0"]')],first=targets[0],last=targets.at(-1);
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===node.current)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===node.current)){event.preventDefault();first?.focus();}
  };
  return <div className="pc-modal"><div className="pc-modal-scrim"/><section ref={node} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={`h-bot-dialog pc-dialog ${className}`} onKeyDown={keyboard}><header className="h-bot-dialog-head"><h2>{title}</h2><button className="pc-icon" aria-label="关闭弹窗" onClick={onClose}><X size={16}/></button></header><div className="h-bot-dialog-body pc-dialog-body">{children}</div>{footer&&<footer className="h-bot-dialog-foot">{footer}</footer>}</section></div>;
}

function desktopPairing(scene){
  const state=createPairingDemo(scene==='request'?'pair-confirm':scene);
  if(!['pair-share','pair-confirm','request'].includes(scene))state.invitation.status='cancelled';
  return {...state,devices:[{id:'current',name:'这台 Mac',current:true,manager:true},{id:'phone',name:'我的 iPhone',lastSeen:'今天 14:32'}]};
}

function DesktopApp(){
  const [scene,setScene]=useState(initialScene),[panel,setPanel]=useState(initialPanel(initialScene));
  const [environment,setEnvironment]=useState(['offline','unsupported','limited'].includes(initialScene)?initialScene:'online');
  const [pairing,dispatch]=useReducer(pairingDemoReducer,initialScene,desktopPairing);
  const [now,setNow]=useState(Date.now),[revision,setRevision]=useState(0),[cancelUnknown,setCancelUnknown]=useState(false),[phoneCompleted,setPhoneCompleted]=useState(false);
  const [target,setTarget]=useState(null),[revokeUnknown,setRevokeUnknown]=useState(null),[revocationReceipt,setRevocationReceipt]=useState(false),[toast,setToast]=useState(''),[editing,setEditing]=useState(null);
  const timers=useRef(new Set()),hydrated=useRef(false),connectionOffline=useRef(false);
  const offline=environment==='offline',canManage=!['limited','unsupported'].includes(environment),canPair=environment==='online';
  const invitation=pairing.invitation,pending=invitation.status==='pending'&&now<invitation.expiresAt;
  const session=useMemo(()=>createPrototypeSession('release',{storageNamespace:'hemi-desktop-design-v1'}),[]),client=session.client;
  const state=useConversation(client),snapshot=state.snapshot,busy=Boolean(snapshot&&snapshot.phase!=='idle');
  const presenter=useMemo(createConversationPresenter,[]),messages=useMemo(()=>presenter(snapshot),[presenter,snapshot]);
  const scope=useMemo(()=>({...client.scope,generation:String(snapshot?.generation??1)}),[client,snapshot?.generation]);
  const later=(fn,delay)=>{const id=setTimeout(()=>{timers.current.delete(id);fn();},delay);timers.current.add(id);};
  const notify=text=>{setToast(text);later(()=>setToast(''),2500);};
  const host=useMemo(()=>({version:1,capabilities:{copyText:true,openLink:false,resolveResource:true,readResource:true,resourceActions:false},copyText:async({text})=>{await navigator.clipboard.writeText(text);return success();},resources:{resolve:async()=>({ok:true,value:{id:'release-file',version:'1'}}),read:async({ref})=>({ok:true,value:{ref,content:{kind:'text',text:fileText,mimeType:'text/markdown'},metadata:{name:'发布说明.md'},release(){}}})}}),[]);
  const onAction=useMemo(()=>{const ordinary=createConversationActionHandler(client,async action=>{if(action.type==='preview.open'){setPanel('file');return success();}return {ok:false,error:{code:'unsupported',message:'此操作暂不可用'}};});return async(action,context)=>{if(action.type==='message.edit-state'){setEditing(action.state==='begin'?action.targetId:null);return success();}const result=await ordinary(action,context);if(action.type==='message.edit'&&result.ok)setEditing(null);return result;};},[client]);
  useEffect(()=>{if(!['open','pending'].includes(invitation.status))return;const tick=()=>{const time=Date.now();setNow(time);if(time>=invitation.expiresAt)dispatch({type:'expire'});};tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[invitation.expiresAt,invitation.status]);
  connectionOffline.current=offline;
  useEffect(()=>{let active=true;void session.preset('conversation').then(()=>{if(active){hydrated.current=true;session.setOffline(connectionOffline.current);}});return()=>{active=false;};},[session]);
  useEffect(()=>{if(hydrated.current)session.setOffline(offline);},[offline,session]);
  useEffect(()=>()=>{session.dispose();for(const timer of timers.current)clearTimeout(timer);},[session]);
  const choose=id=>{
    const next=desktopPairing(id);dispatch({type:'replace-demo',value:next});setScene(id);setPanel(initialPanel(id));setEnvironment(['offline','unsupported','limited'].includes(id)?id:'online');setNow(Date.now());setRevision(value=>value+1);setCancelUnknown(false);setPhoneCompleted(false);setTarget(null);setRevokeUnknown(null);setRevocationReceipt(false);setToast('');history.replaceState(null,'',`?scene=${id}`);
  };
  const generate=()=>{if(!canPair)return;dispatch({type:'generate',now:Date.now()});setNow(Date.now());setRevision(value=>value+1);setCancelUnknown(false);setPhoneCompleted(false);setPanel('pairing');};
  const closePairing=()=>{
    if(invitation.status==='open'){
      if(offline){setCancelUnknown(true);setPanel('cancel-unknown');return;}
      dispatch({type:'cancel'});
    }
    setPanel(null);
  };
  const pairAction=action=>{
    if(['generate','approve','reject'].includes(action.type)&&!canPair)return;
    if(action.type==='generate'){setNow(action.now);setRevision(value=>value+1);setPhoneCompleted(false);}
    dispatch(action);
  };
  const simulateRequest=()=>{if(!canPair||cancelUnknown||!['open'].includes(invitation.status))return;dispatch({type:'request',now:Date.now()});};
  const requestRevoke=()=>{
    if(offline||revocationReceipt){setRevokeUnknown(target);setTarget(null);setPanel('devices');return;}
    dispatch({type:'revoke',id:target.id});setTarget(null);setPanel('devices');notify('已撤销这台设备的访问');
  };
  const reconcile=()=>{
    if(offline)return;
    if(cancelUnknown){dispatch({type:'cancel'});setCancelUnknown(false);setPanel('settings');notify('已核对：配对邀请已取消');}
    if(revokeUnknown){dispatch({type:'revoke',id:revokeUnknown.id});setRevokeUnknown(null);notify('已核对：设备访问已撤销');}
  };
  const send=async()=>{const result=await client.sendDraft();if(!result.ok)notify(result.message||'草稿已保留，请稍后重试');};
  const managerNote=offline?'恢复连接后才能配对或撤销设备。':environment==='unsupported'?'当前 Bot 尚未启用设备配对，请先更新并配置安全配对入口。':!canManage?'当前设备没有配对管理权限，请使用原管理设备操作。':'手机可以使用流量或 Wi-Fi，无需与电脑处于同一网络。';

  return <main className="pc-prototype">
    <header className="pc-review"><div><strong>Hemi 桌面端设备配对</strong><span>交互稿 · 演示数据</span></div><nav aria-label="桌面交互稿场景">{cases.map(([id,label])=><button key={id} aria-current={scene===id?'page':undefined} onClick={()=>choose(id)}>{label}</button>)}</nav><a href="./?scene=pair-scan">查看手机稿<ChevronRight size={13}/></a></header>
    <section className="pc-window" aria-label="桌面应用交互预览">
      <div className="pc-shell" inert={panel?true:undefined}>
        <header className="pc-appbar"><div className="pc-brand"><span className="pc-traffic" aria-hidden="true"><i/><i/><i/></span><span>Hemi</span></div><div className="pc-conversation-heading"><strong>发布前检查</strong><span>Bot · 默认空间</span></div><div className="pc-top-actions">{pending&&!cancelUnknown&&<button className="pc-request-indicator" aria-label="新设备请求 1" onClick={()=>{setPanel('pairing');setRevision(value=>value+1);}}><Smartphone size={14}/>新设备请求<span>1</span></button>}<span className={`pc-connection ${offline?'is-offline':''}`}><i/>{offline?'连接已断开':'Bot 在线'}</span><button className="pc-icon" aria-label="Bot 设置" onClick={()=>setPanel('settings')}><Settings size={16}/></button></div></header>
        <aside className="pc-rail" aria-label="应用导航"><span className="pc-rail-item"><MessageSquare size={18}/></span><span className="pc-rail-item is-active"><Cloud size={18}/></span><span className="pc-rail-item"><Folder size={18}/></span></aside>
        <aside className="pc-conversations"><div className="pc-sidebar-heading"><span>Hemi Bot</span><span className="pc-icon" aria-hidden="true"><Plus size={16}/></span></div><p>对话</p><div className="pc-conversation-row is-active">发布前检查</div><div className="pc-conversation-row">整理项目文档</div><div className="pc-conversation-row">检查服务器磁盘</div><footer><Cloud size={14}/><span>cloud.example.com</span></footer></aside>
        <section className="pc-chat" aria-label="当前 Bot 对话">{offline&&<div className="pc-inline-notice"><WifiOff size={15}/><span>连接已断开，配对与撤销状态需要恢复后核对。</span></div>}{cancelUnknown&&<div className="pc-inline-notice"><ShieldCheck size={15}/><span>有一项配对取消结果待核对</span><button disabled={offline} onClick={reconcile}>核对结果</button></div>}
          <ConversationFlow scope={scope} messages={messages} host={host} onAction={onAction} state={{busy,editingMessageId:editing,retryBlocked:offline?'恢复连接后重试':undefined}}/>
          <div className="pc-composer"><textarea aria-label="桌面对话消息" placeholder="发送消息给 Hemi…" value={state.draft.text} onChange={event=>client.draft.setText(event.target.value)}/><div><span>工作模型</span><span>默认空间</span><button className="pc-send" aria-label="发送桌面消息" disabled={!state.draft.text.trim()} onClick={()=>void send()}><ArrowUp size={17}/></button></div></div>
        </section>
      </div>
      {panel==='settings'&&<DesktopDialog title="Bot 设置" onClose={()=>setPanel(null)} footer={<button className="h-bot-btn" onClick={()=>setPanel(null)}>完成</button>}><p className="h-bot-host">cloud.example.com</p><dl className="h-bot-dl"><dt>连接</dt><dd>{offline?'连接已断开':'已连接'}</dd><dt>常驻服务</dt><dd>{offline?'状态待核对':'运行中'}</dd><dt>默认空间</dt><dd><code>/home/ubuntu/hemi-workspace</code></dd><dt>可用模型</dt><dd>2 个</dd></dl><section className="pc-device-settings"><h3>设备</h3><button className="pc-setting-row" disabled={!canPair||cancelUnknown} onClick={generate}><QrCode size={17}/><span><strong>连接新设备</strong><small>生成两分钟有效的一次性配对码</small></span><ChevronRight size={15}/></button><button className="pc-setting-row" onClick={()=>setPanel('devices')}><Laptop size={17}/><span><strong>已连接设备</strong><small>查看设备，单独撤销访问</small></span><ChevronRight size={15}/></button>{pending&&<button className="pc-setting-row" onClick={()=>setPanel('pairing')}><Smartphone size={17}/><span><strong>有一台新设备等待确认</strong><small>核对验证码后允许连接</small></span><ChevronRight size={15}/></button>}<p className="pc-muted">{managerNote}</p></section></DesktopDialog>}
      {panel==='pairing'&&<PairingPanel key={`${invitation.id}-${revision}`} Dialog={DesktopDialog} completed={phoneCompleted} state={pairing} now={now} offline={!canPair} onAction={pairAction} onClose={closePairing} onDevices={()=>setPanel('devices')}/>}
      {panel==='devices'&&<DesktopDialog title="已连接设备" onClose={()=>setPanel(null)} footer={<><button className="h-bot-btn" onClick={()=>setPanel('settings')}><ArrowLeft size={13}/>返回设置</button><button className="h-bot-btn primary" disabled={!canPair||cancelUnknown} onClick={generate}><Plus size={14}/>连接新设备</button></>}><p className="pc-muted">每台设备使用独立身份。撤销访问不会停止已受理的云端任务。</p>{revokeUnknown&&<div className="pc-inline-notice" role="status"><span>“{revokeUnknown.name}”的撤销结果待核对</span><button disabled={offline} onClick={reconcile}>核对结果</button></div>}<div className="pc-device-table" role="table" aria-label="已连接设备列表"><div className="pc-device-table-head" role="row"><span role="columnheader">设备</span><span role="columnheader">最近连接</span><span role="columnheader">管理</span></div>{pairing.devices.map(device=><div className={`pc-device-table-row ${device.revoked?'is-revoked':''}`} role="row" key={device.id}><span role="cell">{device.current?<Laptop size={17}/>:<Smartphone size={17}/>}<span><strong>{device.name}</strong><small>{device.current?'当前设备':device.revoked?'访问已撤销':'自有设备'}</small></span></span><span role="cell">{device.revoked?'—':device.current?'刚刚':device.id===invitation.request?.id&&!phoneCompleted?'等待首次连接':device.lastSeen}</span><span role="cell">{device.current?<span className="pc-muted">本机</span>:device.revoked?<span className="pc-muted">已撤销</span>:<button className="pc-revoke" aria-label={`撤销 ${device.name}`} disabled={!canManage||offline||Boolean(revokeUnknown)} onClick={()=>{setTarget(device);setPanel('revoke');}}>撤销访问</button>}</span></div>)}</div><p className="pc-muted pc-separated">设备上已经缓存的内容无法远程收回。{offline?'离线时不能提交撤销操作。':''}</p></DesktopDialog>}
      {panel==='revoke'&&target&&<DesktopDialog title="撤销设备访问" onClose={()=>{setTarget(null);setPanel('devices');}} footer={<><button className="h-bot-btn" onClick={()=>{setTarget(null);setPanel('devices');}}>取消</button><button className="h-bot-btn primary" disabled={!canManage} onClick={requestRevoke}>撤销访问</button></>}><h3 className="sheet-title">撤销“{target.name}”的访问？</h3><p className="body-copy">该设备会断开连接，之后需要重新配对。其他设备和云端任务不受影响。</p><p className="body-copy">设备上已缓存的数据无法远程收回。</p>{offline&&<p className="pc-muted">连接已断开；提交结果需要恢复后核对。</p>}</DesktopDialog>}
      {panel==='cancel-unknown'&&<DesktopDialog title="取消结果待核对" onClose={()=>setPanel(null)} footer={<button className="h-bot-btn primary" disabled={offline} onClick={reconcile}>核对结果</button>}><p className="body-copy">旧二维码已隐藏，但尚未确认云端邀请是否取消。恢复连接后核对结果，期间不会重新展示或生成邀请码。</p></DesktopDialog>}
      {panel==='file'&&<DesktopDialog title="发布说明.md" onClose={()=>setPanel(null)}><pre className="pc-file-preview">{fileText}</pre></DesktopDialog>}
      {toast&&<div className="pc-toast" role="status">{toast}</div>}
    </section>
    <aside className="pc-demo-controls" aria-label="桌面稿演示操作"><strong>演示操作</strong><button disabled={!canPair||cancelUnknown||invitation.status!=='open'} onClick={simulateRequest}>模拟手机扫码申请</button><button disabled={!['open','pending'].includes(invitation.status)} onClick={()=>dispatch({type:'expire'})}>模拟邀请过期</button><button disabled={invitation.status!=='used'||phoneCompleted} onClick={()=>{setPhoneCompleted(true);notify('演示：手机已完成首次连接');}}>模拟手机完成连接</button><button onClick={()=>setEnvironment(value=>value==='offline'?'online':'offline')}>{offline?'恢复演示连接':'模拟 PC 断线'}</button><label><input type="checkbox" checked={revocationReceipt} onChange={event=>setRevocationReceipt(event.target.checked)}/>模拟撤销回执丢失</label></aside>
    <p className="pc-review-note">沿用现有桌面 Bot 设置与对话样式，仅展示此次新增的设备交互。设备、二维码和操作均为本机演示；不会连接真实 Bot 或改变任何授权。待确认请求的关闭按钮仅收起详情，拒绝需明确点击；二维码等待扫码时关闭则取消邀请。</p>
    <p className="pc-review-note"><a href="./?scene=pair-scan">手机扫码稿</a><span> → 识别云端 Bot → 等待 PC 核对 </span><span className="pc-code-example">{comparisonCode}</span><span> → 允许连接 → 首次连接完成。两端在本稿中通过演示事件推进。</span></p>
  </main>;
}

createRoot(document.getElementById('root')).render(<DesktopApp/>);
