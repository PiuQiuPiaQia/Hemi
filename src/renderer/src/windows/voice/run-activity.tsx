import {useMemo} from 'react';
import {useConversationBridge,useConversationEnvironmentId} from './lib/conversation-bridge';
import type {FlowActionHandler} from '@hemi/conversation-flow';
import type { BackgroundJobView, RunActivityView } from "@shared/protocol";
import {
  ConversationFlowProvider,
  ConversationActivity as SDKRunActivity,
} from "@hemi/conversation-flow/parts";
import { useDesktopFlowAppearance } from "./conversation-flow";
import { useAppearance } from "@/appearance/use-appearance";

/** Keep the run summary beside the desktop composer, using the SDK's actual implementation. */
export function RunActivity({
  activity,
  backgroundJobs,
  active = true,
  conversationId,
  generation,
  readOnly,
}: {
  activity?: RunActivityView | null;
  backgroundJobs?: BackgroundJobView[];
  conversationId?: string | null;
  generation?: number;
  readOnly?: boolean;
  active?: boolean;
}) {
  const bridge=useConversationBridge(),environmentId=useConversationEnvironmentId();
  const onAction=useMemo<FlowActionHandler>(()=>async(action)=>{
    if(action.type!=='background.command'||!conversationId)return {ok:false,error:{code:'unsupported',message:'当前会话不可操作'}};
    const result=await bridge.flowCommand(conversationId,{type:'backgroundCommand',targetRunId:action.targetId,action:action.action,jobId:action.jobId,from:action.from},{requestId:action.requestId,generation:generation??null});
    return result.ok?{ok:true,value:{receipt:'completed',data:result.data}}:{ok:false,error:{code:'failed',message:result.message??'任务状态已变化'}};
  },[bridge,conversationId,generation]);
  const { tokens, container } = useDesktopFlowAppearance();
  const { activity: visibility } = useAppearance();
  return (
    <div ref={container} className="contents">
      <ConversationFlowProvider
        part
        onAction={onAction}
        scope={{
          environmentId,
          conversationId:conversationId??"run-summary",
          generation:String(generation??1),
        }}
        appearance={{ tokens }}
        active={active && visibility.visible}
      >
        <SDKRunActivity activity={activity} backgroundJobs={backgroundJobs} readOnly={readOnly} />
      </ConversationFlowProvider>
    </div>
  );
}
