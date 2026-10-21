import {useCallback,useRef,useState,type KeyboardEvent} from 'react';
import {Check,LoaderCircle,Shirt} from 'lucide-react';
import {SKINS} from '@shared/appearance/skins.mjs';
import type {SkinId} from '@shared/appearance/types';
import {InfoPopover} from './info-popover';
import {BrandIcon} from './brand-icon';
import {assetsFor} from '@/appearance/assets';
import {useAppearance} from '@/appearance/use-appearance';
import {chooseSkin} from '@/appearance/runtime';

export function SkinPicker(){
  const {snapshot}=useAppearance(),selected=snapshot.preference.skinId;
  const [open,setOpen]=useState(false),[focused,setFocused]=useState<SkinId>(selected),[error,setError]=useState(''),[pending,setPending]=useState<SkinId|null>(null);
  const buttons=useRef(new Map<SkinId,HTMLButtonElement>()),sequence=useRef(0);
  const changeOpen=useCallback((value:boolean)=>{setOpen(value);if(value){setFocused(selected);setError('');}},[selected]);
  const select=async(id:SkinId)=>{
    setFocused(id);setError('');const request=++sequence.current;setPending(id);
    try{const result=await chooseSkin(id);if(request===sequence.current&&!result.ok)setError(result.code==='BACKUP_FAILED'?'无法备份原外观配置，请检查文件权限后重试。':'皮肤未能保存，请重试。');}
    catch{if(request===sequence.current)setError('皮肤未能保存，请重试。');}
    finally{if(request===sequence.current)setPending(null);}
  };
  const onKey=(event:KeyboardEvent<HTMLButtonElement>,id:SkinId)=>{
    const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-2,ArrowDown:2}[event.key];if(delta===undefined)return;
    event.preventDefault();event.stopPropagation();const index=SKINS.findIndex(s=>s.id===id),next=SKINS[(index+delta+SKINS.length)%SKINS.length].id;buttons.current.get(next)?.focus();void select(next);
  };
  return <InfoPopover open={open} onOpenChange={changeOpen} title="换肤" side="right" align="end" className="skin-picker" initialFocus={()=>buttons.current.get(selected)??null} trigger={<button type="button" className="h24-navrail-item" data-current={open?'true':undefined} title="换肤" aria-label="换肤"><Shirt className="size-4" aria-hidden="true"/></button>}>
    <div className="skin-grid" role="radiogroup" aria-label="选择皮肤">{SKINS.map(skin=>{
      const current=selected===skin.id,asset=assetsFor(skin.id);
      return <button key={skin.id} ref={node=>{if(node)buttons.current.set(skin.id,node);else buttons.current.delete(skin.id);}} type="button" className="skin-card" role="radio" aria-checked={current} aria-label={skin.name} tabIndex={focused===skin.id?0:-1} data-selected={current?'true':undefined} style={{'--skin-card-bg':skin.colors['--bg-rail'],'--skin-card-accent':skin.colors['--accent'],'--skin-card-hover':skin.colors['--bg-hover']} as React.CSSProperties} onFocus={()=>setFocused(skin.id)} onClick={()=>void select(skin.id)} onKeyDown={event=>onKey(event,skin.id)}>
        <span className="skin-card-name">{skin.name}</span>{asset?<img className="skin-card-portrait" src={asset.portrait} alt=""/>:<BrandIcon className="skin-card-brand"/>}
        <span className="skin-card-state">{pending===skin.id?<><LoaderCircle className="skin-saving" aria-hidden="true"/>保存中</>:current?<><Check aria-hidden="true"/>使用中</>:<span className="skin-swatches" aria-hidden="true">{['--bg-rail','--g-300','--accent'].map(key=><i key={key} style={{background:skin.colors[key]}}/>)}</span>}</span>
      </button>;
    })}</div>{error?<p className="skin-picker-error" role="alert">{error}</p>:null}
  </InfoPopover>;
}
