import {useEffect,useRef,useState,type CSSProperties,type RefObject} from 'react';
import {getSkin} from '@shared/appearance/skins.mjs';
import {assetsFor,type SkinAssets} from './assets';
import {useAppearance} from './use-appearance';
import {useAppearanceScene} from './scene';

export function useReducedMotion(){const [reduced,setReduced]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),changed=()=>setReduced(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);return reduced;}
export function ThemeLettering({className='',headline,subline}:{className?:string;headline:string|null;subline:string|null}){return headline?<div className={`theme-home-copy ${className}`} aria-hidden="true"><strong>{headline}</strong><p>{subline}</p><svg viewBox="0 0 320 60" fill="none" aria-hidden="true"><path d="M7 47C65 27 146 11 295 9" stroke="currentColor" strokeWidth=".9" strokeLinecap="round"/><path d="M86 54C141 35 224 20 312 17" stroke="currentColor" strokeWidth=".9" strokeLinecap="round"/></svg></div>:null;}
export function CharacterMedia({asset,load,videoRef,staticOnly=false,className='',onReady}:{asset:SkinAssets;load:boolean;videoRef:RefObject<HTMLVideoElement|null>;staticOnly?:boolean;className?:string;onReady?:()=>void}){
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const video=videoRef.current;if(!video||!load||staticOnly)return;setReady(false);setFailed(false);video.src=asset.motion;video.load();
    return()=>{video.pause();video.removeAttribute('src');video.load();};
  },[asset.motion,load,staticOnly,videoRef]);
  return <div className={`theme-actor ${className}`} data-video-ready={!staticOnly&&ready&&!failed?'true':undefined} style={{aspectRatio:`${asset.width}/${asset.height}`,'--media-left':`${-asset.paddingX/asset.width*100}%`,'--media-top':`${-asset.paddingY/asset.height*100}%`,'--media-width':`${(asset.width+asset.paddingX*2)/asset.width*100}%`,'--media-height':`${(asset.height+asset.paddingY*2)/asset.height*100}%`} as CSSProperties} aria-hidden="true">
    <img src={asset.image} alt="" draggable={false}/>{staticOnly?null:<video ref={videoRef} muted loop playsInline preload={load?'auto':'none'} onLoadedData={()=>{setReady(true);onReady?.();}} onError={()=>{if(videoRef.current?.getAttribute('src')){setFailed(true);videoRef.current?.pause();onReady?.();}}}/>}
  </div>;
}
export function ThemeBackdrop({intro,videoRef}:{intro:boolean;videoRef:RefObject<HTMLVideoElement|null>}){
  const {snapshot,activity}=useAppearance(),scene=useAppearanceScene(),reduced=useReducedMotion(),skin=getSkin(snapshot.preference.skinId),asset=assetsFor(skin.id);
  const [documentVisible,setDocumentVisible]=useState(()=>!document.hidden);
  const [focusedInput,setFocusedInput]=useState(false),[requested,setRequested]=useState(false),[mediaVersion,setMediaVersion]=useState(0);
  const requestedSkin=useRef(skin.id);if(requestedSkin.current!==skin.id){requestedSkin.current=skin.id;requested&&setRequested(false);}
  useEffect(()=>{const check=()=>setFocusedInput(!!document.activeElement?.matches('input:not([type=range]):not([type=checkbox]),textarea,[contenteditable="true"]'));document.addEventListener('focusin',check);document.addEventListener('focusout',check);check();return()=>{document.removeEventListener('focusin',check);document.removeEventListener('focusout',check);};},[]);
  const staticOnly=!intro&&scene.view!=='home';
  const idle=!staticOnly&&scene.view==='home'&&!scene.inputActive&&!focusedInput&&activity.visible&&activity.focused&&documentVisible&&!reduced;
  useEffect(()=>{if(intro||idle)setRequested(true);},[intro,idle,skin.id]);
  useEffect(()=>{
    const video=videoRef.current;if(!video||intro)return;
    if(idle&&requested&&video.readyState>=2)void video.play().catch(()=>{});else video.pause();
  },[intro,idle,requested,mediaVersion,staticOnly,videoRef,skin.id]);
  useEffect(()=>{const hidden=()=>{setDocumentVisible(!document.hidden);if(document.hidden)videoRef.current?.pause();};document.addEventListener('visibilitychange',hidden);return()=>document.removeEventListener('visibilitychange',hidden);},[videoRef]);
  if(!asset)return null;
  return <><div className="theme-home-backdrop" data-view={scene.view} aria-hidden="true"><CharacterMedia key={`${skin.id}:${staticOnly?'static':'motion'}`} asset={asset} load={requested&&!staticOnly} staticOnly={staticOnly} videoRef={videoRef} className="theme-home-actor" onReady={()=>setMediaVersion(v=>v+1)}/></div><div className="theme-lettering-layer" data-view={scene.view}><ThemeLettering headline={skin.headline} subline={skin.subline}/></div></>;
}
