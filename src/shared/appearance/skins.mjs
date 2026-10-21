const definitions = [
  ['classic','经典','#f6f6f5','#566e5d','#f2f5f1','#e4ebe3','#cfdcd1','#bccbbd','#8fa794','#74907b','#4b6152','#3e5044','#e9e9e7',null,null],
  ['cafe-blue','晴海蓝','#edf2fb','#385f9f','#edf3ff','#dfe9fb','#c4d5f5','#a5bee9','#7d9dd6','#587fc1','#2e508c','#253f70','#dce4f0','Smile','DeepSeek'],
  ['cafe-purple','月见紫','#f4effa','#70509c','#f6f2fc','#ebe2f5','#daceeb','#c1aadf','#a78acb','#8965b0','#61428b','#513475','#e4dceb','Sister','GPT'],
  ['cafe-orange','焦糖橙','#f8efe7','#a6502e','#fbf2ea','#f2e0d0','#e9c6ac','#dba582','#cb835b','#b76841','#914225','#78351f','#e8dbce','Suspended','Claude'],
  ['cafe-gold','蜜糖金','#faf4e5','#876318','#fbf5e8','#f0e6c8','#e4d29e','#cdb46e','#b49a4e','#9c7e30','#745313','#604410','#e8dfc9','Sweet','Grok'],
  ['cafe-red','围巾红','#f9efed','#a63034','#fcf2f0','#f1dedd','#e8bfbd','#dba19f','#cc7b7c','#bb565a','#90262c','#772028','#eadbd8','Stupid','Doubao'],
];

export const SKINS = Object.freeze(definitions.map(([id,name,rail,accent,g50,g100,g200,g300,g500,g600,g800,g900,line,headline,subline]) => Object.freeze({
  id,name,windowBackground:id==='classic'?'#fafcfb':rail,headline,subline,
  colors:Object.freeze({
    '--bg-rail':rail,'--bg-navrail':rail,'--bg-canvas':'#ffffff','--bg-surface':'#ffffff','--bg-subtle':g50,
    '--bg-hover':`color-mix(in srgb, ${accent} 5%, transparent)`,'--bg-active':`color-mix(in srgb, ${accent} 9%, transparent)`,
    '--bg-scrim':'rgb(26 26 25 / 28%)','--ink':'#1a1a19','--body':'#2d2d2c','--muted':'#696966','--faint':'#8b8b88',
    '--line':line,'--line-strong':g200,'--accent':accent,'--accent-hover':g800,'--accent-press':g900,'--accent-soft':g50,'--accent-text':accent,
    '--fill-primary':id==='classic'?'#1a1a19':accent,'--fill-primary-hover':id==='classic'?'#2d2d2c':g800,'--on-primary':'#ffffff',
    '--focus-ring':`0 0 0 3px color-mix(in srgb, ${accent} 24%, transparent)`,
    '--g-50':g50,'--g-100':g100,'--g-200':g200,'--g-300':g300,'--g-500':g500,'--g-600':g600,'--g-700':accent,'--g-800':g800,'--g-900':g900,
    '--status-success':'#2f6b45','--status-success-soft':'#f2f5f1','--status-running':'#526b8c','--status-running-soft':'#edf2f8',
    '--danger':'#b4483d','--danger-50':'#fbefed','--danger-200':'#ecd0cb','--warn':'#a2701c','--warn-50':'#faf3e6','--warn-200':'#ead9b4',
    '--code-surface':'#f8f8f7','--preview-surface':'#ffffff','--disabled-ink':'#8b8b88',
    '--theme-scene-start':g100,'--theme-scene-end':g200,'--theme-lettering':({'cafe-blue':'#7893b6','cafe-purple':'#a08ab9','cafe-orange':'#b78b6d','cafe-gold':'#b59d6f','cafe-red':'#b58583'})[id]??g600,
  }),
})));
export const SKIN_IDS = Object.freeze(SKINS.map(skin=>skin.id));
export const getSkin = id => SKINS.find(skin=>skin.id===id) ?? SKINS[0];
