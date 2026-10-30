import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessagePhaseStream, nativeMessagePhase, textFactOf, restoreNativeMessagePhases } from './message-phase.mjs';
import { reduceTurnParts } from './turn-parts.mjs';
import { createRunPartProjector } from '../main/services/flow-parts-projection.mjs';
import { applyFlowFact, createFlowSnapshot } from './conversation-flow.mjs';

test('late provider phase targets its original text across tools; answers cannot become commentary', () => {
  const events = [], tracker = createMessagePhaseStream(event => events.push(event));
  tracker.update({ type: 'text_start', contentIndex: 0, partial: {content: [{type:'text',text:''}]} });
  tracker.update({ type: 'text_delta', contentIndex: 0, delta: '**完整答案**', partial: {content: [{type:'text',text:'**完整答案**'}]} });
  tracker.update({ type: 'text_end', contentIndex: 0, partial: {content: [{textSignature:'{"v":1,"id":"answer","phase":"partial_answer"}'}]} });
  tracker.finish({ stopReason: 'toolUse', content: [{type:'text',text:'**完整答案**'}, {type:'toolCall'}] });
  const id = events[0].textId;
  let parts = events.map(textFactOf).filter(Boolean).reduce((parts, fact) => reduceTurnParts(parts, fact), []);
  parts = reduceTurnParts(parts, {kind:'tool_start',tool:'register_delivery',toolCallId:'delivery'});
  parts = reduceTurnParts(parts, {kind:'text-phase',textId:id,phase:'commentary',phaseSource:'provider'});
  assert.equal(parts[0].phase, 'partial_answer');
  assert.equal(parts[0].text, '**完整答案**');
  tracker.reset(); tracker.update({type:'text_start',contentIndex:0});
  assert.notEqual(events.at(-1).textId, id, 'indices reused by a later request cannot alias old text');
});

test('provider metadata is read from SDK signature, never prose; invalid phases fail visible', () => {
  assert.equal(nativeMessagePhase({text:'{"phase":"commentary"}'}), undefined);
  assert.equal(nativeMessagePhase({textSignature:'{"v":1,"id":"x","phase":"commentary"}'}), 'commentary');
  assert.equal(nativeMessagePhase({textSignature:'{"v":1,"id":"x","phase":"hide_everything"}'}), undefined);
  assert.equal(nativeMessagePhase({textSignature:'{"v":1,"id":"x","phase":"unclassified"}'}), undefined);
  const events = [], tracker = createMessagePhaseStream(event => events.push(event));
  tracker.update({type:'text_start',contentIndex:0});
  tracker.update({type:'text_delta',contentIndex:0,delta:'进度'});
  tracker.update({type:'text_end',contentIndex:0,partial:{content:[{textSignature:'{"v":1,"id":"x","phase":"commentary"}'}]}});
  tracker.finish({stopReason:'stop',content:[{textSignature:'{"v":1,"id":"x","phase":"commentary"}'}]});
  assert.equal(events.find(event=>event.type==='hemi_text_phase').phase, 'commentary');
  assert.equal(events.filter(event=>event.type==='hemi_text_phase').length, 1);
});

for (const stopReason of ['stop', 'toolUse', 'error']) {
  test(`unmarked text falls back immediately without a repair or stop-reason inference: ${stopReason}`, () => {
    const events=[],tracker=createMessagePhaseStream(event=>events.push(event));
    tracker.update({type:'text_start',contentIndex:0});
    tracker.update({type:'text_delta',contentIndex:0,delta:'**正文保持原样**'});
    assert.equal(events[0].phase,'unclassified');
    assert.equal(events[1].phase,'unclassified');
    assert.equal(events[1].phaseSource,'contract');
    const count=events.length;
    tracker.finish({stopReason,content:[{type:'text',text:'**正文保持原样**'}]});
    assert.equal(events.length,count,'finishing unclassified text produces no repair or semantic relabel');
    const parts=events.map(textFactOf).filter(Boolean).reduce((parts,fact)=>reduceTurnParts(parts,fact),[]);
    assert.equal(parts[0].phase,'unclassified');
    assert.equal(parts[0].text,'**正文保持原样**');
  });
}

test('provider history restoration requires native identity and exact content; contract labels never leak', () => {
  const payload={input:[
    {type:'message',role:'assistant',id:'native',content:[{type:'output_text',text:'原始答案'}]},
    {type:'message',role:'assistant',id:'changed',content:[{type:'output_text',text:'改过的答案'}]},
    {type:'message',role:'assistant',id:'contract',content:[{type:'output_text',text:'普通正文'}]},
  ]};
  restoreNativeMessagePhases(payload,[{role:'assistant',content:[
    {type:'text',text:'原始答案',textSignature:'{"v":1,"id":"native","phase":"partial_answer"}'},
    {type:'text',text:'原始答案',textSignature:'{"v":1,"id":"changed","phase":"partial_answer"}'},
    {type:'text',text:'普通正文',phase:'final_answer',phaseSource:'contract'},
  ]}]);
  assert.deepEqual(payload.input.map(item=>item.phase),['partial_answer',undefined,undefined]);
});

test('phase and text boundaries survive production projector, flow reducer and JSON roundtrip', () => {
  const projector = createRunPartProjector({runId:'r'});
  let flow = createFlowSnapshot({conversationId:'c'});
  flow = applyFlowFact(flow,{type:'run-preparing',runId:'r',source:'user',at:1}).snapshot;
  flow = applyFlowFact(flow,{type:'run-started',runId:'r',at:2}).snapshot;
  const facts = [
    {kind:'text-start',textId:'p',phase:'commentary',phaseSource:'contract'},
    {kind:'text',textId:'p',text:'先核对资料'},
    {kind:'text-start',textId:'a'}, {kind:'text',textId:'a',text:'完整答案'},
    {kind:'text-phase',textId:'a',phase:'partial_answer',phaseSource:'contract'},
    {kind:'tool_start',tool:'register_delivery',toolCallId:'d'},
    {kind:'tool_end',tool:'register_delivery',toolCallId:'d'},
    {kind:'text-start',textId:'f'}, {kind:'text',textId:'f',text:'已登记来源'},
    {kind:'text-phase',textId:'f',phase:'final_answer',phaseSource:'contract'},
  ];
  let archive = [];
  for (const event of facts) {
    archive = reduceTurnParts(archive,event);
    for (const fact of projector.handle(event)) flow = applyFlowFact(flow,fact).snapshot;
  }
  const texts = JSON.parse(JSON.stringify(flow)).timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='text');
  assert.deepEqual(texts.map(part=>[part.content,part.phase]), [['先核对资料','commentary'],['完整答案','partial_answer'],['已登记来源','final_answer']]);
  assert.deepEqual(archive.filter(part=>part.type==='text').map(part=>[part.text,part.phase]), texts.map(part=>[part.content,part.phase]));
  assert.notEqual(flow.phase, 'completed', 'a final_answer label must not settle the run');
});

test('retry clears old phase targets without replaying tool facts or losing prior answers', () => {
  const projector=createRunPartProjector({runId:'r'});
  projector.handle({kind:'text-start',textId:'old-answer'});
  projector.handle({kind:'text',textId:'old-answer',text:'已交付答案'});
  projector.handle({kind:'text-phase',textId:'old-answer',phase:'partial_answer'});
  projector.handle({kind:'request-start'});
  projector.handle({kind:'text-start',textId:'failed-attempt'});
  projector.handle({kind:'text',textId:'failed-attempt',text:'失败请求的文字'});
  const reset=projector.handle({kind:'request-reset'});
  assert.equal(reset.length,1);
  assert.equal(reset[0].patch.content,'');
  assert.deepEqual(projector.handle({kind:'text-phase',textId:'failed-attempt',phase:'commentary'}),[]);
  projector.handle({kind:'text-start',textId:'new-attempt'});
  const fresh=projector.handle({kind:'text',textId:'new-attempt',text:'恢复后的答案'});
  assert.equal(fresh[0].part.textId,'new-attempt');
  assert.equal(fresh[0].part.phase,undefined);
});
