/** A bounded failure is not a confirmed stop. Keep accepted inputs and pause dispatch. */
export function closeUnconfirmedCommand(controller,{runId,generation,error,at=Date.now()}) {
  const snapshot=controller.getSnapshot();
  if(snapshot.activeRunId!==runId||snapshot.generation!==generation)return false;
  controller.applyFact({type:'queue-paused',generation});
  controller.applyFact({type:'part-appended',runId,generation,part:{kind:'notice',partId:runId+'-cleanup-unconfirmed',level:'error',text:error.message}});
  controller.applyFact({type:'run-closed',runId,generation,at,outcome:'failed',cleanupUnconfirmed:true});
  return true;
}
