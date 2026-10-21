import {SKIN_IDS} from './skins.mjs';
export const DEFAULT_APPEARANCE = Object.freeze({schemaVersion:1,skinId:'classic',mode:'light'});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function validPreference(value){return exact(value,['schemaVersion','skinId','mode'])&&value.schemaVersion===1&&SKIN_IDS.includes(value.skinId)&&value.mode==='light';}
export function validAppearanceRequest(value){return exact(value,['requestId','skinId','mode'])&&typeof value.requestId==='string'&&/^[\w-]{1,128}$/.test(value.requestId)&&SKIN_IDS.includes(value.skinId)&&value.mode==='light';}
export function validSnapshot(value){return record(value)&&typeof value.sessionId==='string'&&value.sessionId.length<=128&&Number.isSafeInteger(value.revision)&&value.revision>=0&&validPreference(value.preference)&&value.resolvedMode==='light';}
export function newerSnapshot(current,next){return validSnapshot(next)&&(!current||current.sessionId===next.sessionId&&next.revision>current.revision);}
