import configs from './skins.config.json' with {type:'json'};
import {createSkinRegistry} from './skin-registry.mjs';

export const SKINS = createSkinRegistry(configs);
export const SKIN_IDS = Object.freeze(SKINS.map(skin => skin.id));
export const getSkin = id => SKINS.find(skin => skin.id === id) ?? SKINS[0];
