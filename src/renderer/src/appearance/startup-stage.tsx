import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {getSkin} from '@shared/appearance/skins.mjs';
import {BrandIcon} from '@/components/brand-icon';
import {assetsFor} from './assets';
import {getAppearanceBootstrap,reportVisualReady} from './runtime';
import {useAppearance} from './use-appearance';
import {useAppearanceScene} from './scene';
import {CharacterMedia,ThemeBackdrop,ThemeLettering,useReducedMotion} from './theme-backdrop';

let startupConsumed=false;
type Phase='preparing'|'intro'|'waiting'|'done';
const smooth=(value:number)=>{const x=Math.min(1,Math.max(0,value));return x*x*(3-2*x);};
const paint=()=>new Promise<void>(resolve=>{const timer=setTimeout(resolve,80);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});
function mediaReady(video:HTMLVideoElement|null,signal:AbortSignal){return new Promise<boolean>(resolve=>{
  if(!video||signal.aborted)return resolve(false);if(video.readyState>=2)return resolve(true);
  const done=()=>finish(true),bad=()=>finish(false),finish=(value:boolean)=>{clearTimeout(timer);video.removeEventListener('loadeddata',done);video.removeEventListener('error',bad);signal.removeEventListener('abort',bad);resolve(value);};
  const timer=setTimeout(bad,1800);video.addEventListener('loadeddata',done,{once:true});video.addEventListener('error',bad,{once:true});signal.addEventListener('abort',bad,{once:true});
});}
export function StartupStage({children,allowIntro=true}:{children:ReactNode;allowIntro?:boolean}){
  const {snapshot,activity}=useAppearance(),sceneState=useAppearanceScene(),reduced=useReducedMotion(),skin=getSkin(snapshot.preference.skinId),asset=assetsFor(skin.id);
  const [eligible]=useState(()=>allowIntro&&!!getAppearanceBootstrap()?.coldStart&&!startupConsumed),[phase,setPhase]=useState<Phase>('preparing'),[longWait,setLongWait]=useState(false);
  const initialSkin=useRef(skin.id),cancelled=useRef(false),begun=useRef(false),appReady=useRef(sceneState.appReady),generation=useRef(0),raf=useRef(0),progress=useRef(0);
  const surface=useRef<HTMLDivElement>(null),front=useRef<HTMLDivElement>(null),stage=useRef<HTMLDivElement>(null),title=useRef<HTMLDivElement>(null),skip=useRef<HTMLButtonElement>(null),homeVideo=useRef<HTMLVideoElement>(null),frontVideo=useRef<HTMLVideoElement>(null);
  appReady.current=sceneState.appReady;
  const intro=eligible&&!!asset&&!reduced&&!cancelled.current&&phase!=='done'&&phase!=='waiting';
  const finish=useCallback(()=>{
    cancelled.current=true;cancelAnimationFrame(raf.current);frontVideo.current?.pause();
    if(surface.current){surface.current.style.transform='none';surface.current.style.opacity='1';surface.current.style.borderRadius='0';surface.current.style.boxShadow='none';}
    setPhase(appReady.current?'done':'waiting');
  },[]);
  useLayoutEffect(()=>{
    if(phase==='done'||!intro&&phase!=='waiting')return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish();}else if(event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();(skip.current??document.querySelector<HTMLButtonElement>('.startup-controls button'))?.focus();}else if(event.target instanceof Node&&!document.querySelector('.startup-controls')?.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}};
    window.addEventListener('keydown',onKey,true);
    const previous=new Map<HTMLElement,boolean>();const block=()=>{for(const node of document.body.children){if(node.id==='root'||!(node instanceof HTMLElement)||previous.has(node))continue;previous.set(node,node.inert);node.inert=true;}};block();const observer=new MutationObserver(block);observer.observe(document.body,{childList:true});
    return()=>{window.removeEventListener('keydown',onKey,true);observer.disconnect();for(const [node,inert]of previous)node.inert=inert;};
  },[phase,intro,finish]);
  useEffect(()=>{startupConsumed=true;let active=true;void paint().then(()=>{if(active)reportVisualReady();});return()=>{active=false;};},[snapshot.sessionId,snapshot.revision]);
  useEffect(()=>{if(initialSkin.current!==skin.id)finish();},[skin.id,finish]);
  useEffect(()=>{if(reduced)finish();},[reduced,finish]);
  useEffect(()=>{if(!eligible||!asset){if(sceneState.appReady)setPhase('done');}else if(phase==='waiting'&&sceneState.appReady)setPhase('done');},[eligible,asset,sceneState.appReady,phase]);
  useEffect(()=>{
    if(phase==='done')return;const timer=setTimeout(()=>setLongWait(true),12000);return()=>clearTimeout(timer);
  },[phase]);
  useEffect(()=>{
    if(!eligible||!asset||reduced||cancelled.current)return;
    if(!activity.visible||!activity.focused){if(begun.current)finish();return;}
    const token=++generation.current,abort=new AbortController();let mounted=true,handoffAligned=false;
    const valid=()=>mounted&&generation.current===token&&!abort.signal.aborted&&!cancelled.current;
    const draw=(ms:number)=>{
      const app=surface.current,actor=front.current,background=stage.current,copy=title.current;if(!app||!actor||!background||!copy)return;
      if(ms>=5100&&!handoffAligned){handoffAligned=true;const home=homeVideo.current,foreground=frontVideo.current;if(home&&foreground&&Math.abs(home.currentTime-foreground.currentTime)>1/30)home.currentTime=foreground.currentTime;}
      progress.current=ms;const t=Math.min(ms,6000)/1000,entry=1-(1-Math.min(1,t/1.1))**3,arrival=smooth((t-1.4)/1.1),expand=smooth((t-3.2)/1.9),leave=smooth((t-5.1)/.65);
      background.style.opacity=String(1-expand);copy.style.opacity=String(1-smooth((t-1.8)/1.25));
      const heading=copy.querySelector<HTMLElement>('strong'),sub=copy.querySelector<HTMLElement>('p');if(heading)heading.style.clipPath=`inset(0 ${(1-smooth((t-.3)/1.2))*100}% 0 -12%)`;if(sub)sub.style.opacity=String(smooth((t-1.05)/.6));copy.querySelectorAll('path').forEach((path,i)=>{path.setAttribute('pathLength','1');path.style.strokeDasharray='1';path.style.strokeDashoffset=String(1-smooth((t-1-i*.15)/1.05));});
      const target=surface.current?.querySelector<HTMLElement>('.theme-home-actor');const targetStyle=target?getComputedStyle(target):null,frontStyle=getComputedStyle(actor);
      const width=parseFloat(frontStyle.width),height=parseFloat(frontStyle.height),x=targetStyle?parseFloat(targetStyle.left)-parseFloat(frontStyle.left):0,y=targetStyle?parseFloat(targetStyle.top)-parseFloat(frontStyle.top):0,scale=targetStyle?parseFloat(targetStyle.width)/width:1;
      actor.style.opacity=String(entry*(1-leave));actor.style.transform=`translate3d(${width*.22*(1-entry)+x*expand}px,${height*.08*(1-entry)+y*expand}px,0) rotate(${2.5*(1-entry)}deg) scale(${1+(scale-1)*expand})`;
      // 窗口 3D 旋转/缩放入场已按用户要求移除（2026-10-29）：应用内容保持原位，仅随 arrival 淡入。
      app.style.opacity=String(arrival);
      const backdrop=app.querySelector<HTMLElement>('.theme-home-backdrop'),lettering=app.querySelector<HTMLElement>('.theme-lettering-layer');if(backdrop)backdrop.style.setProperty('--startup-character-opacity',String(leave));if(lettering)lettering.style.opacity=String(smooth((t-4.7)/.65));
    };
    void (async()=>{
      const loaded=await Promise.all([mediaReady(homeVideo.current,abort.signal),mediaReady(frontVideo.current,abort.signal)]);if(!valid())return;
      if(loaded.some(value=>!value)){finish();return;}
      const videos=[homeVideo.current!,frontVideo.current!];videos.forEach(video=>{video.currentTime=0;});
      try{await Promise.all(videos.map(video=>video.play()));}catch{if(valid())finish();return;}
      if(!valid()){videos.forEach(video=>video.pause());return;}
      begun.current=true;setPhase('intro');const start=performance.now()-progress.current;draw(progress.current);
      const tick=(now:number)=>{if(!valid())return;const ms=now-start;draw(ms);if(ms>=6000){finish();return;}raf.current=requestAnimationFrame(tick);};raf.current=requestAnimationFrame(tick);
    })();
    const resize=()=>{if(begun.current)finish();};window.addEventListener('resize',resize);
    return()=>{mounted=false;generation.current++;abort.abort();cancelAnimationFrame(raf.current);window.removeEventListener('resize',resize);frontVideo.current?.pause();};
  },[eligible,asset,reduced,activity.visible,activity.focused,finish]);
  useEffect(()=>{
    if(phase!=='done')return;
    const app=surface.current;if(app){app.style.transform='none';app.style.opacity='1';app.style.borderRadius='0';app.style.boxShadow='none';app.querySelector<HTMLElement>('.theme-home-backdrop')?.style.removeProperty('--startup-character-opacity');app.querySelector<HTMLElement>('.theme-lettering-layer')?.style.removeProperty('opacity');}
  },[phase]);
  return <div className="appearance-stage" data-startup={phase}>
    <div ref={surface} className="appearance-app-surface" inert={intro||phase==='waiting'}><ThemeBackdrop intro={intro} videoRef={homeVideo}/>{children}</div>
    {phase!=='done'?<div className="startup-overlay" aria-label="应用正在准备">
      {intro&&asset?<><div ref={stage} className="startup-scene"/><div ref={front} className="startup-foreground" style={{aspectRatio:`${asset.width}/${asset.height}`}}><CharacterMedia key={skin.id} asset={asset} load={!reduced} videoRef={frontVideo}/></div><div ref={title} className="startup-title"><ThemeLettering headline={skin.headline} subline={skin.subline}/></div></>:<div className="startup-brand"><BrandIcon width={40} height={40}/></div>}
      <div className="startup-controls"><span role="status">{phase==='waiting'?(longWait?'应用准备时间较长，请重试。':'正在准备应用…'):null}</span>{intro?<button ref={skip} type="button" onClick={finish}>跳过</button>:null}{longWait?<button type="button" onClick={()=>location.reload()}>重新加载</button>:null}</div>
    </div>:null}
  </div>;
}
