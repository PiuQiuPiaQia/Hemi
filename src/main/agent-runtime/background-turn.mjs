import {goalRunOutcome} from './goal-driver.mjs';
import {createRunPartProjector} from '../services/flow-parts-projection.mjs';

/** A host event uses the normal foreground slot, with the original goal's owner and budget. */
export async function runBackgroundTurn({runtime,conversationId,runId,generation,background,apply,saveReply=async()=>{},onDelivery=()=>{},onModelCall=()=>{}}){
  const projector=createRunPartProjector({runId,generation,inputId:null});
  const fact=event=>{for(const value of projector.handle(event))apply(value);};
  const stream=event=>{
    if(event.type==='text_delta')fact({kind:'text',text:event.delta});
    else if(event.type==='thinking_delta')fact({kind:'thinking',text:event.delta});
    else if(event.type==='thinking_end')fact({kind:'thinking_end'});
    else if(event.type==='hemi_message_end')fact({kind:'message-end'});
    else if(event.type==='hemi_request_start')fact({kind:'request-start'});
    else if(event.type==='hemi_request_reset')fact({kind:'request-reset'});
  };
  const activity=value=>fact({kind:'activity',activity:value});
  const recovery=value=>fact({kind:'recovery',recovery:value});
  const progress=value=>{
    fact({...value,kind:value.kind==='tool-start'?'tool_start':'tool_end'});
    if(value.kind==='tool-end'&&value.tool==='register_delivery'&&!value.isError)onDelivery(value.args?.files??[]);
  };
  let session,outcome='failed',skipRoot=false;
  try{
    const result=await runtime.resumeBackground(conversationId,{...background,flowRunId:runId},{onReady(agent){
      session=agent;
      agent.on('stream',stream);agent.on('activity',activity);agent.on('recovery',recovery);agent.on('progress',progress);
      agent.on('model-call',onModelCall);
      apply({type:'run-started',runId,generation,at:Date.now()});
    }});
    skipRoot=Boolean(result.skipped);
    outcome=goalRunOutcome(result);
    for(const value of projector.finish({stopped:result.aborted,blocked:result.blocked,halted:result.halted}))apply(value);
    await runtime.persist(conversationId);
    await saveReply(result);
    return result;
  }catch(error){
    outcome='failed';
    for(const value of projector.finish({error}))apply(value);
    throw error;
  }finally{
    session?.off('stream',stream);session?.off('activity',activity);session?.off('recovery',recovery);session?.off('progress',progress);
    session?.off('model-call',onModelCall);
    if(!skipRoot)await runtime.completeConversation(conversationId,outcome,null,background.rootRunId);
  }
}
