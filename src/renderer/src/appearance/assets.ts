import blue from '@/assets/skins/cafe-blue.webp';
import purple from '@/assets/skins/cafe-purple.webp';
import orange from '@/assets/skins/cafe-orange.webp';
import gold from '@/assets/skins/cafe-gold.webp';
import red from '@/assets/skins/cafe-red.webp';
import bluePortrait from '@/assets/skins/cafe-blue-portrait.webp';
import purplePortrait from '@/assets/skins/cafe-purple-portrait.webp';
import orangePortrait from '@/assets/skins/cafe-orange-portrait.webp';
import goldPortrait from '@/assets/skins/cafe-gold-portrait.webp';
import redPortrait from '@/assets/skins/cafe-red-portrait.webp';
import blueMotion from '@/assets/skins/cafe-blue-idle.webm';
import purpleMotion from '@/assets/skins/cafe-purple-idle.webm';
import orangeMotion from '@/assets/skins/cafe-orange-idle.webm';
import goldMotion from '@/assets/skins/cafe-gold-idle.webm';
import redMotion from '@/assets/skins/cafe-red-idle.webm';
import type {SkinId} from '@shared/appearance/types';
export type SkinAssets={image:string;portrait:string;motion:string;width:number;height:number;paddingX:number;paddingY:number};
export const skinAssets:Record<Exclude<SkinId,'classic'>,SkinAssets>={
  'cafe-blue':{image:blue,portrait:bluePortrait,motion:blueMotion,width:1135,height:1386,paddingX:48,paddingY:16},
  'cafe-purple':{image:purple,portrait:purplePortrait,motion:purpleMotion,width:1197,height:1314,paddingX:48,paddingY:16},
  'cafe-orange':{image:orange,portrait:orangePortrait,motion:orangeMotion,width:1060,height:1484,paddingX:48,paddingY:16},
  'cafe-gold':{image:gold,portrait:goldPortrait,motion:goldMotion,width:1114,height:1412,paddingX:48,paddingY:16},
  'cafe-red':{image:red,portrait:redPortrait,motion:redMotion,width:1110,height:1417,paddingX:48,paddingY:16},
};
export const assetsFor=(id:SkinId)=>id==='classic'?null:skinAssets[id];
