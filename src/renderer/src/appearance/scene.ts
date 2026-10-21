import {useEffect,useSyncExternalStore} from 'react';
type Scene={view:'home'|'reading'|'other';inputActive:boolean;appReady:boolean};
let current:Scene={view:'other',inputActive:false,appReady:false};const listeners=new Set<()=>void>();
export function setAppearanceScene(next:Partial<Scene>){const value={...current,...next};if(JSON.stringify(value)===JSON.stringify(current))return;current=value;for(const listener of listeners)listener();}
export const useAppearanceScene=()=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>current,()=>current);
export function useThemeScene(view:Scene['view'],inputActive=false){useEffect(()=>{setAppearanceScene({view,inputActive});return()=>setAppearanceScene({view:'other',inputActive:false});},[view,inputActive]);}
