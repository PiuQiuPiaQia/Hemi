import test from 'node:test';
import assert from 'node:assert/strict';
import { contextExtension } from './context-extension.mjs';
function fixture(put=async()=> 'ctx-raw') {
 const hooks={},tools={};const execution={owner:{conversationId:'c'},budgets:{outputChars:100},plan:{primary:{supportsVision:false}},contextStore:{put}};
 contextExtension({getExecution:()=>execution,sourceFor:async()=>({kind:'tool'}),validateSource:async()=>true}).factory({on:(name,fn)=>hooks[name]=fn,registerTool:tool=>tools[tool.name]=tool});
 return {hooks,tools,execution};
}
test('多个短块合计超过限制也在首次入史前投影，必要尾部错误保留',async()=>{
 const {hooks}=fixture();const result=await hooks.tool_result({toolName:'bash',content:[{type:'text',text:'FIRST'+'x'.repeat(60)},{type:'text',text:'y'.repeat(60)+'ERROR_7'}]});
 assert.match(result.content[0].text,/FIRST/);assert.match(result.content[0].text,/ERROR_7/);assert.match(result.content[0].text,/ctx-raw/);
});
test('快照失败显式失败且阻止新动作，不让 SDK 吞钩子异常后发送原文',async()=>{
 const {hooks,execution}=fixture(async()=>{throw Error('disk failure');});
 const result=await hooks.tool_result({toolName:'read',content:[{type:'text',text:'RAW'.repeat(100)}]});
 assert.equal(result.isError,true);assert.match(execution.fatalError,/disk failure/);assert.doesNotMatch(result.content[0].text,/RAW/);
 assert.equal(hooks.tool_call({toolName:'write',input:{}}).block,true);
});
test('文本模型的隐式动作后截图也要拒绝，停止后的报告读取不访问事实库',async()=>{
 const {hooks,tools,execution}=fixture();assert.equal(hooks.tool_call({toolName:'ui_type',input:{text:'x'}}).block,true);
 assert.equal(hooks.tool_call({toolName:'ui_type',input:{text:'x',view:false}}),undefined);
 execution.cancelled=()=>true;const result=await tools.task_read.execute('id',{taskId:'old'});assert.equal(result.isError,true);
});

test('read 等任意工具的图像不能被文本候选静默丢弃；切到真实图像候选后仍可携带',async()=>{
 const {hooks,execution}=fixture();const event={toolName:'read',content:[{type:'image',mimeType:'image/png',data:'UNSEEN_IMAGE'}]};
 const result=await hooks.tool_result(event);assert.match(result.content[0].text,/unsupported-modality/);assert.equal(result.isError,true);assert.equal(result.details.hemiUnsupportedModality,true);assert.doesNotMatch(JSON.stringify(result),/UNSEEN_IMAGE/);
 execution.actualCandidate={supportsVision:true};assert.equal(await hooks.tool_result(event),undefined);
});

test('会话分页不再次裁剪；conv ID 误传任务工具时给出正确入口', async () => {
 const {hooks,tools}=fixture();
 assert.equal(await hooks.tool_result({toolName:'conversation_read',content:[{type:'text',text:'x'.repeat(1000)}]}),undefined);
 const error=await tools.task_read.execute('id',{taskId:'conv-archive'});
 assert.equal(error.isError,true); assert.match(error.content[0].text,/conversation_read/);
});

test('context_read 复核会话来源，不能绕过删除或编辑后的失效', async () => {
 const {tools,execution}=fixture();
 execution.contextStore.read=async args=>({allowed:await args.validateSource({kind:'conversation',conversationId:'conv-old'})});
 execution.validateConversationSource=()=>false;
 assert.equal((await tools.context_read.execute('id',{ref:'ctx-history'})).allowed,false);
 execution.validateConversationSource=source=>source.conversationId==='conv-old';
 assert.equal((await tools.context_read.execute('id',{ref:'ctx-history'})).allowed,true);
});
