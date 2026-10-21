const SCALE = [50, 100, 200, 300, 500, 600, 800, 900];
const FONT_SIZES = {home:104, medium:72, narrow:62, startup:136, startupMedium:136, startupNarrow:92, startupCompact:80};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
function requireValue(condition, message) { if (!condition) throw new Error(`Skin configuration: ${message}`); }
function keys(value, allowed, label) {
  requireValue(record(value) && Object.keys(value).every(key => allowed.includes(key)), `${label} has unknown fields`);
}
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function freeze(value) {
  if (record(value) || Array.isArray(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

/** Validate the authoring catalog once, then share the same contract with Node and the renderer. */
export function createSkinRegistry(configs) {
  requireValue(Array.isArray(configs) && configs.length > 0 && configs[0]?.id === 'classic', 'classic must be the first entry');
  const ids = new Set();
  return freeze(configs.map(config => {
    keys(config, ['id','name','windowBackground','palette','interaction','lettering','assets'], 'skin');
    const {id, name, palette, lettering, assets} = config;
    requireValue(typeof id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) && !ids.has(id), `invalid or duplicate ID ${id}`);
    ids.add(id);
    requireValue(text(name), `${id}: name is required`);
    keys(palette, ['rail','accent','line','scale'], `${id}: palette`);
    keys(palette.scale, SCALE.map(String), `${id}: scale`);
    requireValue([palette.rail,palette.accent,palette.line,...SCALE.map(step=>palette.scale[step])].every(hex), `${id}: palette requires complete hex colors`);
    requireValue(config.windowBackground === undefined || hex(config.windowBackground), `${id}: invalid window background`);
    const interaction = {color:palette.accent, hover:16, active:24, activeHover:30, ...config.interaction};
    if (config.interaction !== undefined) keys(config.interaction, ['color','hover','active','activeHover'], `${id}: interaction`);
    requireValue(hex(interaction.color) && ['hover','active','activeHover'].every(key=>Number.isFinite(interaction[key]) && interaction[key] > 0 && interaction[key] <= 40), `${id}: invalid interaction colors`);
    requireValue(interaction.hover < interaction.active && interaction.active < interaction.activeHover, `${id}: hover, selection and selected hover must be distinct`);
    const sizes = {...FONT_SIZES, ...lettering?.sizes};
    if (lettering !== null) {
      keys(lettering, ['headline','subline','color','sizes'], `${id}: lettering`);
      requireValue(text(lettering.headline) && text(lettering.subline) && hex(lettering.color), `${id}: incomplete lettering`);
      if (lettering.sizes !== undefined) keys(lettering.sizes, Object.keys(FONT_SIZES), `${id}: lettering sizes`);
      requireValue(Object.values(sizes).every(value=>Number.isFinite(value) && value >= 12 && value <= 320), `${id}: invalid lettering size`);
    }
    if (assets !== null) {
      keys(assets, ['image','portrait','motion','width','height','paddingX','paddingY','durationMs','framesPerSecond','motionKind'], `${id}: assets`);
      for (const [key,extension] of [['image','webp'],['portrait','webp'],['motion','webm']]) {
        requireValue(typeof assets[key] === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(assets[key]) && !assets[key].includes('..') && assets[key].endsWith(`.${extension}`), `${id}: invalid ${key} filename`);
      }
      requireValue(['width','height','durationMs','framesPerSecond'].every(key=>Number.isSafeInteger(assets[key]) && assets[key] > 0) && ['paddingX','paddingY'].every(key=>Number.isSafeInteger(assets[key]) && assets[key] >= 0) && text(assets.motionKind), `${id}: invalid media metadata`);
    }
    requireValue(id !== 'classic' || assets === null && lettering === null, 'classic has no character or lettering');
    const {rail,accent,line,scale:g} = palette;
    const tint = amount => `color-mix(in srgb, ${interaction.color} ${amount}%, #ffffff)`;
    return {
      id,name,windowBackground:config.windowBackground ?? rail,
      headline:lettering?.headline ?? null,subline:lettering?.subline ?? null,
      assets:assets === null ? null : structuredClone(assets),
      colors:{
        '--bg-rail':rail,'--bg-navrail':rail,'--bg-canvas':'#ffffff','--bg-surface':'#ffffff','--bg-subtle':g[50],
        '--bg-hover':tint(interaction.hover),'--bg-active':tint(interaction.active),'--bg-active-hover':tint(interaction.activeHover),
        '--bg-scrim':'rgb(26 26 25 / 28%)','--ink':'#1a1a19','--body':'#2d2d2c','--muted':'#696966','--faint':'#8b8b88',
        '--line':line,'--line-strong':g[200],'--accent':accent,'--accent-hover':g[800],'--accent-press':g[900],'--accent-soft':g[50],'--accent-text':accent,
        '--fill-primary':id==='classic'?'#1a1a19':accent,'--fill-primary-hover':id==='classic'?'#2d2d2c':g[800],'--on-primary':'#ffffff',
        '--focus-ring':`0 0 0 3px color-mix(in srgb, ${accent} 24%, transparent)`,
        ...Object.fromEntries([...SCALE,700].map(step=>[`--g-${step}`,step===700?accent:g[step]])),
        '--status-success':'#2f6b45','--status-success-soft':'#f2f5f1','--status-running':'#526b8c','--status-running-soft':'#edf2f8',
        '--danger':'#b4483d','--danger-50':'#fbefed','--danger-200':'#ecd0cb','--warn':'#a2701c','--warn-50':'#faf3e6','--warn-200':'#ead9b4',
        '--code-surface':'#f8f8f7','--preview-surface':'#ffffff','--disabled-ink':'#8b8b88',
        '--theme-scene-start':g[100],'--theme-scene-end':g[200],'--theme-lettering':lettering?.color ?? g[600],
        ...Object.fromEntries(Object.entries(sizes).map(([key,value])=>[`--theme-type-${key.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`)}`,`${value}px`])),
      },
    };
  }));
}
