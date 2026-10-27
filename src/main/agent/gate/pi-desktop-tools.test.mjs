import test from 'node:test';
import assert from 'node:assert/strict';
import hemiAx from './pi-ax.mjs';
import hemiVision from './pi-vision.mjs';

test('desktop action refusal ends the batch and is reported as an error, not a successful delivery', async () => {
  const tools = new Map();let following = false;
  const driver = {
    listAppWindows: async () => [{pid: 1, name: 'Fixture', bundleId: 'win32:exe:fixture', frontmost: true, windows: [{windowId: '2'}]}],
    windowState: async () => ({elements: [{elementToken: 'token', role: 'Edit', label: 'Input'}]}),
    setValue: async () => ({isError: true, errorCode: 'unsupported', text: 'ValuePattern unavailable'}),
    key: async () => {following = true;},
  };
  hemiAx({registerTool: tool => tools.set(tool.name, tool)}, {config: {driver, bareRefThreshold: 1}});
  await tools.get('ui_tree').execute('tree', {app: 'Fixture'});
  const result = await tools.get('ui_act').execute('act', {actions: [{op: 'set_value', ref: 't1', value: 'test'}, {op: 'press', combo: 'ctrl+a'}]});
  assert.equal(result.isError, true);assert.match(result.content[0].text, /ValuePattern unavailable/);assert.equal(following, false);
});

test('failed desktop actions never capture the whole screen; missing targets produce no image', async () => {
  const tools = new Map();let windows = 0;
  const driver = {desktopState: async () => {throw new Error('must never capture the desktop');},
    windowState: async () => {windows++;return {images: []};}, typeText: async () => ({isError: true, text: 'locked', errorCode: 'locked'})};
  hemiVision({registerTool: tool => tools.set(tool.name, tool)}, {config: {enabled: true, driver}});
  const missing = await tools.get('ui_type').execute('missing', {text: 'text'});assert.equal(windows, 0);assert.ok(missing.content.every(block => block.type !== 'image'));
  const missingShot = await tools.get('screen_view').execute('missing-shot', {});assert.equal(missingShot.isError, true);assert.equal(windows, 0);
  const result = await tools.get('ui_type').execute('refused', {text: 'text', target: {pid: 1, windowId: '2'}, view: false});
  assert.equal(result.details.actionState, 'not-executed');assert.match(result.content[0].text, /键入未执行/);
});

test('Windows element actions keep exact input/key refs, clear fields and select the requested window', async () => {
  const tools=new Map(),calls=[];
  const driver={listAppWindows:async()=>[{pid:1,name:'Fixture',bundleId:'fixture',windows:[{windowId:'2'},{windowId:'3'}]}],
    windowState:async input=>{calls.push(['state',input]);return {screenshotWidth:500,screenshotHeight:400,images:[{}],elements:[{elementToken:'edit',role:'Edit',label:'Input',value:'current value',frame:{x:20,y:30,w:80,h:40}}]};},
    setValue:async input=>{calls.push(['set',input]);return {};},typeText:async input=>{calls.push(['type',input]);return {};},key:async input=>{calls.push(['key',input]);return {};},scroll:async input=>{calls.push(['scroll',input]);return {};}};
  hemiAx({registerTool:tool=>tools.set(tool.name,tool)},{config:{driver,bareRefThreshold:1,captureGeometry:true}});
  const tree=await tools.get('ui_tree').execute('tree',{target:{pid:1,windowId:'3'}});assert.match(tree.content[0].text,/current value/);
  assert.equal(calls[0][1].windowId,'3');assert.equal(calls[0][1].includeScreenshot,true);
  const result=await tools.get('ui_act').execute('act',{actions:[{op:'set_value',ref:'t1',value:''},{op:'type',ref:'t1',text:'test'},{op:'press',ref:'t1',combo:'ctrl+a'},{op:'scroll',ref:'t1',amount:3}]});
  assert.equal(result.isError,false);assert.equal(calls.find(([k])=>k==='set')[1].value,'');
  assert.equal(calls.find(([k])=>k==='type')[1].elementToken,'edit');assert.equal(calls.find(([k])=>k==='key')[1].elementToken,'edit');
  assert.deepEqual([calls.find(([k])=>k==='scroll')[1].x,calls.find(([k])=>k==='scroll')[1].y],[60,50]);
  await tools.get('ui_tree').execute('missing',{target:{pid:1,windowId:'404'}});
  assert.equal((await tools.get('ui_act').execute('stale',{actions:[{op:'set_value',ref:'t1',value:'must not run'}]})).isError,true);
});
