import {useEffect, useRef, useState} from 'react';
import {QrCode, RefreshCw, Smartphone} from 'lucide-react';
import QRCode from 'qrcode';
import type {BotMethod, BotState} from '@shared/bot';
import type {BotPairInvitation, BotPairStatus} from '@shared/bot-pairing';
import {BotButton, BotDialog} from './dialogs';

type Call = <T = unknown>(method: BotMethod, params?: Record<string, unknown>) => Promise<T>;
type Pending = {method: BotMethod; params: Record<string, unknown>};
const message = (error: unknown) => error instanceof Error ? error.message : '操作结果待核对，请恢复连接后检查。';

export function BotPairing({state, call, onClose, onBack}: {state: BotState; call: Call; onClose(): void; onBack(): void}) {
  const instanceId = useRef(state.binding?.instanceId).current;
  const storageKey = `hemi-bot-pairing-operation:${instanceId}`;
  const [status, setStatus] = useState<BotPairStatus | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [unsupported, setUnsupported] = useState(false), [checked, setChecked] = useState(false);
  const [desktopOutdated,setDesktopOutdated] = useState(false);
  const [qr, setQr] = useState(''), [clock, setClock] = useState(Date.now());
  const [revoking,setRevoking] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<Pending | null>(() => {try {return JSON.parse(localStorage.getItem(storageKey) ?? 'null');} catch {return null;}});
  const current = useRef<{invite: BotPairInvitation | null; pending: Pending | null; owns: boolean}>({invite:null,pending:uncertain,owns:false});
  const alive = useRef(true), reading = useRef(false), mutation = useRef(false);
  const epoch=useRef(0);
  const prepared=useRef(false);
  const online = useRef(state.online); online.current=state.online;
  const invoke: Call = (method, params) => call(method, {...params, expectedInstanceId:instanceId});
  const remember = (pending: Pending | null) => {
    if (pending) localStorage.setItem(storageKey,JSON.stringify(pending)); else localStorage.removeItem(storageKey);
    current.current.pending=pending; setUncertain(pending);
  };
  async function read() {
    if (reading.current || !online.current || mutation.current) return;
    reading.current=true;
    const sequence=epoch.current;
    try {
      const next=await invoke<BotPairStatus>('pairing.status',{inviteId:current.current.invite?.inviteId});
      if (!alive.current || sequence!==epoch.current) return;
      setUnsupported(false); setDesktopOutdated(false); setStatus(next); current.current.invite=next.invitation;
      if(next.invitation?.request)setQr('');
      if (next.invitation?.status!=='waiting') {setQr(''); current.current.owns=false;}
      const pending=current.current.pending;
      if (pending?.params.operationId) {
        const receipt=await invoke<{status:string}>('pairing.operation',{operationId:pending.params.operationId});
        if (alive.current && receipt.status==='done') {remember(null);setError('');setNotice('已核对设备操作结果，请查看当前状态。');}
        else if(alive.current && receipt.status==='missing' && next.invitation && ['expired','cancelled','rejected'].includes(next.invitation.status)) {remember(null);setNotice('邀请已失效，Bot 未记录上次授权操作。');}
      }
    } catch (error) {
      if (!alive.current) return;
      if(message(error)==='不支持的 Bot 操作。'){setDesktopOutdated(true);setUnsupported(false);}
      else if ((error as {code?:string})?.code==='unsupported' || message(error)==='不支持的操作。'){setDesktopOutdated(false);setUnsupported(true);}
      else setError(message(error));
    } finally {reading.current=false;}
  }
  useEffect(() => {
    alive.current=true; void read();
    const timer=window.setInterval(()=>{setClock(Date.now());void read();},1500);
    return () => {
      alive.current=false;clearInterval(timer);
      const value=current.current;
      if(value.owns && value.invite?.status==='waiting' && !value.invite.request && !value.pending) {
        const pending: Pending={method:'pairing.cancel',params:{inviteId:value.invite.inviteId,operationId:crypto.randomUUID()}};
        try {localStorage.setItem(storageKey,JSON.stringify(pending));} catch { /* Server deadline remains authoritative if local storage is unavailable. */ }
        void invoke(pending.method,pending.params).then(()=>{if(localStorage.getItem(storageKey)===JSON.stringify(pending))localStorage.removeItem(storageKey);}).catch(()=>{});
      }
    };
  },[]);
  useEffect(()=>{if(!state.online)setQr('');else void read();},[state.online]);
  const invitation=status?.invitation, pending=invitation?.request;
  const pendingIdentity=pending ? `${invitation?.inviteId}:${pending.requestId}:${pending.deviceId}` : '';
  useEffect(()=>setChecked(false),[pendingIdentity]);
  useEffect(()=>{
    if (!status || !state.online || state.busy || uncertain || prepared.current) return;
    prepared.current=true;
    if (status.invitation?.status!=='waiting') void perform('pairing.create');
  },[status,state.online,state.busy,uncertain]);
  async function perform(method: BotMethod, params: Record<string,unknown> = {}, complete?: () => void) {
    if(mutation.current || !state.online)return;
    mutation.current=true;setBusy(true);setError('');setNotice('');
    epoch.current++;
    const tracked=['pairing.approve','pairing.cancel','pairing.reject','devices.revoke'].includes(method);
    const operation=tracked ? {method,params:{...params,operationId:crypto.randomUUID()}} : null;
    try {
      if(operation)remember(operation);
      if(method==='pairing.create' && !status?.enabled) {
        const configured=await invoke<BotPairStatus>('pairing.configure');
        if(!alive.current || !online.current)return;
        setStatus(configured);
      }
      const result=await invoke<BotPairInvitation>(method,operation?.params ?? params);
      if(!alive.current) {
        if(method==='pairing.create') {
          const cancel: Pending={method:'pairing.cancel',params:{inviteId:result.inviteId,operationId:crypto.randomUUID()}};
          try {localStorage.setItem(storageKey,JSON.stringify(cancel));} catch { /* Still cancel on the server if local storage is unavailable. */ }
          void invoke(cancel.method,cancel.params).then(()=>{if(localStorage.getItem(storageKey)===JSON.stringify(cancel))localStorage.removeItem(storageKey);}).catch(()=>{});
        }
        return;
      }
      if(operation)remember(null);
      if(method==='pairing.create') {
        current.current.invite=result;current.current.owns=true;
        setClock(Date.now());
        setStatus(old=>old ? {...old,invitation:result} : old);
        const image=await QRCode.toDataURL(result.qr!,{width:288,margin:4,errorCorrectionLevel:'M'});
        if(alive.current && online.current && current.current.invite?.inviteId===result.inviteId && !current.current.invite.request)setQr(image);
      } else {
        setQr('');
        if(['pairing.approve','pairing.cancel','pairing.reject'].includes(method))current.current.owns=false;
        if(method==='pairing.approve')setNotice('已允许连接，等待手机首次连接。');
        if(method==='devices.revoke'){setRevoking(null);setNotice('已撤销该设备的访问。');}
      }
      complete?.();
    } catch (error) {
      if(alive.current) {
        setQr('');setError(message(error));
        const code=(error as {code?:string})?.code;
        if(operation && code && !['offline','needs-review','failed'].includes(code))remember(null);
      }
    } finally {
      mutation.current=false;
      if(alive.current){setBusy(false);void read();}
    }
  }
  async function close(back=false) {
    if(busy)return;
    if(current.current.pending){setQr('');setError('上次操作结果待核对，请恢复连接后核对。');return;}
    if(current.current.invite?.request?.status==='pending'){current.current.owns=false;(back ? onBack : onClose)();return;}
    if(current.current.invite?.status==='waiting') {
      setQr('');await perform('pairing.cancel',{inviteId:current.current.invite.inviteId},back ? onBack : onClose);
    } else (back ? onBack : onClose)();
  }
  function hide() {
    setQr('');
    if(current.current.invite?.status==='waiting'&&!current.current.invite.request&&!current.current.pending)remember({method:'pairing.cancel',params:{inviteId:current.current.invite.inviteId,operationId:crypto.randomUUID()}});
    onClose();
  }
  async function reconnect() {
    setBusy(true);setError('');
    try {const next=await invoke<BotState>('connection.reconnect');if(!next.online)setError('连接仍未恢复，请检查服务器网络后重试。');}
    catch(error){setError(message(error));}finally{if(alive.current)setBusy(false);}
  }
  const remaining=invitation ? Math.max(0,Math.ceil((invitation.expiresAt-clock)/1000)) : 0;
  const active=invitation?.status==='waiting' && remaining>0;
  const locked=busy || !!state.busy || !state.online || !!uncertain;
  return <BotDialog title="连接新设备" busy={busy} onClose={()=>void close()} footer={<><BotButton disabled={busy} onClick={()=>void close(true)}>Bot 设置</BotButton><BotButton disabled={busy} onClick={()=>void close()}>完成</BotButton></>}>
    <p className="h-bot-host"><Smartphone size={14} aria-hidden="true"/>{state.binding?.host}</p>
    {!state.online ? <div role="status"><p>PC 连接已断开，恢复连接后才能签发或确认设备。</p><BotButton disabled={busy} onClick={()=>void reconnect()}>重新连接</BotButton><BotButton disabled={busy} onClick={hide}>隐藏配对页</BotButton><p className="h-bot-small">旧二维码已隐藏，未完成的邀请到期后失效。</p></div> : null}
    {desktopOutdated ? <p role="alert">PC 后台仍是旧版本，请完全退出 Hemi 后重新启动，再打开设备连接。</p> : unsupported ? <div><p>云端组件尚不支持设备配对，请先维护云端组件。</p><BotButton disabled={busy || !state.online} onClick={()=>void perform('component.update')}>维护云端组件</BotButton></div> : !status ? <p role="status">正在读取设备连接状态…</p> : <>
      {!status.enabled ? <>
        <p>{busy ? '正在准备当前 Bot 的连接二维码…' : '将当前 Bot 连接到手机，扫码后即可申请连接。'}</p>
        {status.error ? <p role="alert" className="h-bot-error">{status.error}</p> : null}
        {!busy ? <BotButton primary disabled={locked} onClick={()=>void perform('pairing.create')}><QrCode size={16} aria-hidden="true"/>重新生成二维码</BotButton> : null}
      </> : <>
        <p>用手机上的 Hemi 扫码，连接当前 Bot。</p>
        {active && qr && !pending ? <figure className="h-bot-pairing-qr"><img src={qr} alt="Hemi 一次性设备配对码"/><figcaption>手机打开 Hemi 扫码 · {remaining} 秒后过期</figcaption></figure> : null}
        {active && pending?.status==='pending' ? <section className="h-bot-device-request" aria-label="新设备申请">
          <strong>{pending.name} 请求连接</strong><p>请与自己手机上显示的验证码核对：</p><p className="h-bot-verification-code">{pending.code.slice(0,3)} {pending.code.slice(3)}</p>
          <p className="h-bot-small">允许后，设备可查看 Bot 对话、读取文件并执行服务器账号权限内的任务。</p>
          <label className="h-bot-pairing-check"><input type="checkbox" checked={checked} disabled={locked} onChange={event=>setChecked(event.target.checked)}/>两台设备显示的验证码一致</label>
          <div className="h-bot-setting-actions"><BotButton disabled={locked} onClick={()=>void perform('pairing.reject',{inviteId:invitation!.inviteId})}>拒绝</BotButton><BotButton primary disabled={locked || !checked} onClick={()=>void perform('pairing.approve',{inviteId:invitation!.inviteId,deviceRequestId:pending.requestId,deviceId:pending.deviceId,code:pending.code})}>允许连接</BotButton></div>
        </section> : null}
        {active && !qr && !pending ? <p role="status">{busy ? '正在生成连接二维码…' : '请取消本次配对后重新生成二维码。'}</p> : null}
        {!active ? <BotButton primary disabled={locked} onClick={()=>void perform('pairing.create')}><QrCode size={16} aria-hidden="true"/>生成配对二维码</BotButton> : <BotButton disabled={locked} onClick={()=>void perform('pairing.cancel',{inviteId:invitation!.inviteId})}>取消本次配对</BotButton>}
        {invitation && !remaining && invitation.status==='waiting' ? <p role="status">邀请已过期，请重新生成。</p> : null}
        <p className="h-bot-small">手机可通过流量或 Wi-Fi 连接。若无法连接，请检查服务器是否已放行 {new URL(status.endpoint).port || '443'} 端口。</p>
      </>}
      {status.devices.length ? <section className="h-bot-devices" aria-label="已登记设备"><h3>已连接设备</h3>{status.devices.map(device=><div className="h-bot-device" key={device.id}><span><strong>{device.name}</strong><small>{device.revokedAt ? '访问已撤销' : device.lastConnectedAt ? `最近连接 ${new Date(device.lastConnectedAt).toLocaleString()}` : '已获准，等待首次连接'}</small></span>{!device.revokedAt ? <BotButton disabled={locked} onClick={()=>setRevoking(device.id)}>撤销访问</BotButton> : null}</div>)}{revoking?<div className="h-bot-device-request" role="group" aria-label="确认撤销设备"><p>撤销 {status.devices.find(device=>device.id===revoking)?.name} 的访问？</p><p className="h-bot-small">会断开该设备的连接。已缓存的数据无法收回，云端已受理的任务继续执行。</p><div className="h-bot-setting-actions"><BotButton disabled={locked} onClick={()=>setRevoking(null)}>取消</BotButton><BotButton disabled={locked} primary onClick={()=>void perform('devices.revoke',{deviceId:revoking})}>确认撤销</BotButton></div></div>:null}</section> : null}
    </>}
    {uncertain ? <div role="status"><p>操作结果待核对。不会重复提交授权。</p><BotButton disabled={busy || !state.online} onClick={()=>void read()}><RefreshCw size={14} aria-hidden="true"/>核对结果</BotButton>{uncertain.method!=='pairing.approve' ? <BotButton disabled={busy || !state.online} onClick={()=>{const operation=current.current.pending;if(operation)void invoke<{status:string}>('pairing.operation',{operationId:operation.params.operationId}).then(receipt=>{if(receipt.status==='missing'){remember(null);setNotice('Bot 尚未记录该操作，请核对当前状态后重试。');}}).catch(error=>setError(message(error)));}}>检查是否受理</BotButton> : null}{state.online?<BotButton disabled={busy} onClick={hide}>稍后核对并关闭</BotButton>:null}</div> : null}
    {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert" className="h-bot-error">{error}</p> : null}
  </BotDialog>;
}
