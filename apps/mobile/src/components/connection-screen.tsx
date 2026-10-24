import {useEffect, useRef, useState} from 'react';
import {Bot, ChevronRight, ScanLine} from 'lucide-react';
import {NativeBot, nativeBotAvailable, type BotTarget, type PairResult} from '../bot/native';
import {Sheet} from './dialog';

export function ConnectionScreen({onLicenses, onConnected, initialPending=null}: {onLicenses(): void; onConnected(target: BotTarget): void; initialPending?: BotTarget|null}) {
  const available=nativeBotAvailable();
  const [manual,setManual]=useState(false), [text,setText]=useState(''), [target,setTarget]=useState<BotTarget|null>(initialPending);
  const [phase,setPhase]=useState<'idle'|'preview'|'waiting'|'checking'|'approved'|'terminal'>(initialPending?'checking':'idle'), [pair,setPair]=useState<PairResult|null>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [leaving,setLeaving]=useState(false);
  const manualTrigger=useRef<HTMLButtonElement>(null), alive=useRef(true), checking=useRef(false), locked=useRef(false);
  const epoch=useRef(0);
  const fail=(error: unknown)=>{if(alive.current)setError(error instanceof Error ? error.message : '连接结果待核对，请检查网络后重试。');};
  async function finish() {const saved=await NativeBot.restore();if(!saved.active)throw new Error('本机连接身份尚未保存，请核对结果。');if(alive.current)onConnected(saved.active);}
  function apply(result: PairResult) {
    if(!alive.current)return;
    setPair(result);
    if(result.status==='pending')setPhase('waiting');
    else if(result.status==='preview')setPhase('preview');
    else if(result.status==='not-received'){setPhase('preview');setError('Bot 尚未受理上次申请，可以重新申请。');}
    else if(result.status==='approved') {setPhase('approved');void finish().catch(fail);}
    else setPhase('terminal');
  }
  async function inspect() {
    if(checking.current || locked.current)return;
    checking.current=true;
    const sequence=epoch.current;
    try {const result=await NativeBot.pairStatus();if(sequence===epoch.current)apply(result);}catch(error){if(sequence===epoch.current)fail(error);}finally{checking.current=false;}
  }
  useEffect(()=>{
    alive.current=true;
    const timer=setTimeout(()=>{if(available&&initialPending)void inspect();},0);
    return()=>{alive.current=false;clearTimeout(timer);};
  },[]);
  useEffect(()=>{if(phase!=='waiting'&&phase!=='checking')return;const timer=setInterval(()=>void inspect(),2000);return()=>clearInterval(timer);},[phase]);
  async function act(action: (sequence: number)=>Promise<void>) {
    if(locked.current)return;locked.current=true;const sequence=++epoch.current;setBusy(true);setError('');
    try {await action(sequence);}catch(error){if(sequence===epoch.current&&(error as {code?:string})?.code!=='cancelled')fail(error);}finally{if(sequence===epoch.current){locked.current=false;if(alive.current)setBusy(false);}}
  }
  async function prepare(qr: string) {const preview=await NativeBot.prepare({qr});if(alive.current){setTarget(preview);setText('');setManual(false);setPair(null);setPhase('preview');}}
  async function cancel() {
    const result=await NativeBot.cancelPairing();
    if(!alive.current)return;
    if(result.status==='approved'){setPhase('approved');setError('PC 已允许此设备。若要撤销访问，请在 PC 的设备列表操作。');return;}
    setPair(null);setTarget(null);setPhase('idle');
  }
  function interrupt() {
    epoch.current++;locked.current=false;setPhase('checking');
    void act(cancel);
  }
  const title=phase==='idle'?'连接你的 Bot':phase==='preview'?'确认连接 Bot':phase==='waiting'?'在 PC 上确认':phase==='approved'?'设备已获准':phase==='terminal'?'本次配对已结束':'核对连接结果';
  const terminal=pair?.status==='expired'?'邀请已过期，请在 PC 重新生成。':pair?.status==='rejected'?'原设备拒绝了这次连接。':pair?.status==='revoked'?'此设备的访问已撤销。':'本次邀请已取消。';
  return <>
    <section className="connection-screen" inert={manual||leaving ? true : undefined}>
      <header className="simple-header"><strong>Hemi</strong></header>
      <div className="connect-scroll connection-landing">
        <div className="connection-intro">
          <div className="connection-symbol" aria-hidden="true"><Bot size={28}/></div>
          <h1>{title}</h1>
          {target?<p className="connection-target">{target.endpoint}</p>:null}
          {phase==='preview'?<p>连接后可访问对话和文件，并执行任务。</p>:null}
          {phase==='waiting'&&pair?.code?<><p className="connection-code">{pair.code.slice(0,3)} {pair.code.slice(3)}</p><p>核对 PC 和手机上的验证码，再在 PC 允许连接。</p></>:null}
          {phase==='checking'?<p>正在核对申请…</p>:null}
          {phase==='terminal'?<p>{terminal}</p>:null}
        </div>
        <div className="connection-actions">
          {error?<p className="connection-availability" role="alert">{error}</p>:null}
          {phase==='idle'?<>
            {!available?<p className="connection-availability" id="connection-availability" role="status">请在原生 App 中连接 Bot</p>:null}
            <button type="button" className="primary-button full-width" disabled={!available||busy} aria-describedby={!available?'connection-availability':undefined} onClick={()=>void act(async()=>{const value=await NativeBot.scan();await prepare(value.qr);})}><ScanLine size={18} aria-hidden="true"/>{busy?'正在打开相机…':'扫码连接 Bot'}</button>
            <p className="connection-hint">在 PC 的 Bot 设置中获取配对码</p>
            <button ref={manualTrigger} type="button" className="text-button connection-manual" disabled={busy} onClick={()=>setManual(true)}>手动连接<ChevronRight size={14} aria-hidden="true"/></button>
          </>:<>
            {phase==='preview'?<button type="button" className="primary-button full-width" disabled={busy} onClick={()=>void act(async sequence=>{try{const result=await NativeBot.pairRequest();if(sequence===epoch.current)apply(result);}catch(error){if(sequence===epoch.current)setPhase('checking');throw error;}})}>{busy?'正在申请…':'申请连接'}</button>:null}
            {phase==='waiting'||phase==='checking'?<button type="button" className="primary-button full-width" disabled={busy} onClick={()=>void inspect()}>核对连接结果</button>:null}
            {phase==='approved'?<button type="button" className="primary-button full-width" disabled={busy} onClick={()=>void act(finish)}>进入 Bot</button>:null}
            {phase==='terminal'?<button type="button" className="primary-button full-width" onClick={()=>{setTarget(null);setPhase('idle');setError('');}}>重新扫码</button>:phase!=='approved'?<button type="button" className="text-button connection-manual" disabled={phase==='checking'&&busy} onClick={interrupt}>{phase==='checking'&&busy?'正在取消等待…':'取消配对'}</button>:null}
            {phase==='checking'&&error&&!busy?<button type="button" className="text-button" onClick={()=>setLeaving(true)}>退出本机等待</button>:null}
          </>}
        </div>
        <footer className="connection-footer"><button type="button" className="text-button" onClick={onLicenses}>开源许可</button></footer>
      </div>
    </section>
    {manual?<Sheet title="手动连接 Bot" returnFocus={manualTrigger.current} onClose={()=>{setManual(false);setText('');}} footer={<button type="button" className="primary-button full-width" disabled={!available||busy||!text.trim()} onClick={()=>void act(()=>prepare(text.trim()))}>读取配对信息</button>}>
      <p className="body-copy">粘贴一次性配对码，核对 Bot 地址后在 PC 允许连接。</p>
      <textarea className="sheet-textarea" aria-label="配对码内容" value={text} onChange={event=>setText(event.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false}/>
      {!available?<p className="field-note">请在原生 App 中完成设备配对。</p>:null}{error?<p className="field-note" role="alert">{error}</p>:null}
    </Sheet>:null}
    {leaving?<Sheet title="退出本机等待？" onClose={()=>setLeaving(false)} footer={<button type="button" className="primary-button full-width" disabled={busy} onClick={()=>void act(async()=>{await NativeBot.forgetPairing();setLeaving(false);setPair(null);setTarget(null);setPhase('idle');})}>移除本机申请</button>}><p className="body-copy">这只移除本机的待确认身份，不代表 Bot 已取消申请。如果 PC 已允许连接，请在 PC 的设备列表撤销。未完成邀请到期后失效。</p></Sheet>:null}
  </>;
}
