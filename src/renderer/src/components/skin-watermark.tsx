import {useAppearance} from '@/appearance/use-appearance';
import {assetsFor} from '@/appearance/assets';
export function SkinWatermark(){const {snapshot}=useAppearance(),asset=assetsFor(snapshot.preference.skinId);return asset?<div className="skin-watermark" aria-hidden="true"><img src={asset.image} alt="" draggable={false}/></div>:null;}
export function SkinWelcomeAvatar(){const {snapshot}=useAppearance(),asset=assetsFor(snapshot.preference.skinId);return asset?<img className="skin-welcome-avatar" src={asset.portrait} alt="" draggable={false}/>:null;}
