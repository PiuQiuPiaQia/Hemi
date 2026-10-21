import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import configs from './skins.config.json' with {type:'json'};
import {createSkinRegistry} from './skin-registry.mjs';
import {generateAppearanceFiles} from '../../../scripts/generate-appearance.mjs';

const extended = () => [...structuredClone(configs), {...structuredClone(configs[1]),id:'test-mint',name:'薄荷验证',lettering:{headline:'Mint',subline:'Hemi',color:'#467c70',sizes:{home:84}}}];

test('a config-only addition participates in types, first-frame bootstrap, CSS, static imports and inventory', async () => {
  const skins = createSkinRegistry(extended()), files = await generateAppearanceFiles(skins);
  const css = files.get('src/renderer/public/appearance-colors.css');
  assert.match(css, /html\[data-skin="test-mint"\]/);
  assert.match(css, /--theme-type-home: 84px/);
  assert.match(files.get('src/shared/appearance/skins.d.mts'), /\|"test-mint"/);
  assert.ok(files.get('src/renderer/src/appearance/assets.ts').includes(`"test-mint":{image:skin${configs.length}image`));
  const inventory = JSON.parse(files.get('src/renderer/src/assets/skins/manifest.json'));
  assert.equal(Object.keys(inventory.skins).length, skins.filter(skin=>skin.assets).length);
  assert.equal(inventory.skins['test-mint'].files[configs[1].assets.image].sha256.length, 64);
  const html = {dataset:{},style:{}}, preference = {skinId:'test-mint'};
  const context = {document:{documentElement:html,querySelector:()=>null},location:{search:''},URLSearchParams,window:{hemiVoice:{getAppearanceBootstrap:()=>({snapshot:{preference},backgroundColor:'#edf2fb'})}}};
  vm.runInNewContext(files.get('src/renderer/public/appearance-bootstrap.js'),context);
  assert.equal(html.dataset.skin,'test-mint');
  preference.skinId='unregistered';
  vm.runInNewContext(files.get('src/renderer/public/appearance-bootstrap.js'),context);
  assert.equal(html.dataset.skin,'classic');
});

test('registry rejects duplicate/unsafe IDs, misspelled fields, invalid colors, media paths and dimensions', () => {
  const edits = [
    list=>list.push({...list[1]}),
    list=>{list[1].id='../outside';},
    list=>{list[1].palette.scale[50]='red; color:black';},
    list=>{delete list[1].palette.scale[100];},
    list=>{list[1].assets.motion='../movie.webm';},
    list=>{list[1].assets.width=0;},
    list=>{list[1].assets.paddingX=-1;},
    list=>{list[1].lettering.sizes={narow:52};},
    list=>{list[1].interaction={hover:25,active:18};},
    list=>{list[1].asset=list[1].assets;},
  ];
  for (const edit of edits) { const list=structuredClone(configs);edit(list);assert.throws(()=>createSkinRegistry(list),/Skin configuration/); }
});

test('defaults preserve shared typography and semantic colors while interaction states remain distinct', () => {
  const skins=createSkinRegistry(configs);
  for (const skin of skins) {
    assert.notEqual(skin.colors['--bg-hover'],skin.colors['--bg-active']);
    assert.notEqual(skin.colors['--bg-active'],skin.colors['--bg-active-hover']);
    assert.equal(skin.colors['--danger'],'#b4483d');
    assert.equal(skin.colors['--status-success'],'#2f6b45');
    assert.ok(Object.isFrozen(skin.colors));
  }
  assert.equal(skins[1].colors['--theme-type-home'],'104px');
  assert.equal(skins.find(skin=>skin.id==='cafe-orange').colors['--theme-type-startup-medium'],'57px');
});

test('missing and empty assets fail generation before any output can be written', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-skin-generation-'));
  try {
    await assert.rejects(generateAppearanceFiles(createSkinRegistry(configs),dir),/missing image asset/);
    await fs.writeFile(path.join(dir,configs[1].assets.image),'');
    await assert.rejects(generateAppearanceFiles(createSkinRegistry(configs),dir),/empty image asset/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('all generated outputs match the current catalog and asset bytes', async () => {
  const files=await generateAppearanceFiles(createSkinRegistry(configs));
  for (const [file,content] of files) assert.equal(await fs.readFile(new URL(`../../../${file}`,import.meta.url),'utf8'),content,file);
});
