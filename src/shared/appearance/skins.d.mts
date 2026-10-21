export type SkinId='classic'|'cafe-blue'|'cafe-purple'|'cafe-orange'|'cafe-gold'|'cafe-red';
export type SkinDefinition={readonly id:SkinId;readonly name:string;readonly windowBackground:string;readonly headline:string|null;readonly subline:string|null;readonly colors:Readonly<Record<string,string>>};
export const SKINS:readonly SkinDefinition[];
export const SKIN_IDS:readonly SkinId[];
export function getSkin(id:unknown):SkinDefinition;
