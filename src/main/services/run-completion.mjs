import {closeUnconfirmedCommand} from './command-cleanup-failure.mjs';

/** Storage is fallible; a settled run must still leave the live execution slot. */
export async function closeConversationRun({ controller, runId, generation, outcome, persist,
  pauseQueue = false, timeoutMs = 5000, now = Date.now, ...facts }) {
  const current = () => {
    const snapshot = controller.getSnapshot();
    return snapshot.activeRunId === runId && snapshot.generation === generation;
  };
  if (!current()) return null;
  if (pauseQueue) controller.applyFact({type:'queue-paused', generation});
  let timer, persistenceError = null;
  try {
    await Promise.race([
      Promise.resolve().then(persist),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('运行状态保存超时'), {code:'run-state-save-timeout'})), timeoutMs); }),
    ]);
  } catch (error) {
    persistenceError = error instanceof Error ? error : new Error(String(error));
    if (error?.code === 'cleanup-unconfirmed') {
      closeUnconfirmedCommand(controller,{runId,generation,error});
      return persistenceError;
    }
    if (current()) {
      controller.applyFact({type:'queue-paused', generation});
      controller.applyFact({type:'part-appended',runId,generation,part:{
        partId:`${runId}-state-save-error`,kind:'notice',level:'error',
        text:`运行状态尚未保存：${persistenceError.message}。自动发送已暂停，请检查本机存储后继续。`,
      }});
      // A successful result whose final state could not be saved is incomplete.
      if (['completed','awaiting-user','awaiting-background','blocked'].includes(outcome)) outcome = 'partial';
    }
  } finally {
    clearTimeout(timer);
    if (current()) controller.applyFact({type:'run-closed',runId,generation,outcome,at:now(),...facts,
      ...(persistenceError ? {dispatchPaused:true} : {})});
  }
  return persistenceError;
}
