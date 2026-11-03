/** Portable view projection: execution and all historical data stay authoritative in the Host. */
const itemId = item => item.kind === 'user' ? item.id : item.itemId;
const WINDOW_QAS = 10, HISTORY_QAS = 10, RECLAIM_BUFFER_QAS = 5;
const pick = (values, ids) => Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => ids.has(id)));
function viewFor(snapshot, timeline, start, total) {
  const runs = new Set(timeline.map(item => item.runId));
  if (snapshot.activeRunId) runs.add(snapshot.activeRunId);
  const tasks = new Set(timeline.flatMap(item => item.parts ?? []).map(part => part.taskId).filter(Boolean));
  for (const [id, task] of Object.entries(snapshot.tasks ?? {}))
    if (!['terminal','completed','failed','stopped'].includes(task.phase) && !task.outcome) tasks.add(id);
  const artifacts = new Set();
  for (const item of timeline) for (const part of item.parts ?? []) if (part.artifactId) artifacts.add(part.artifactId);
  for (const [id, artifact] of Object.entries(snapshot.artifacts ?? {}))
    if (runs.has(artifact.runId ?? artifact.producerRunId) || tasks.has(artifact.taskId)) artifacts.add(id);
  return {...snapshot,timeline,runs:pick(snapshot.runs,runs),tasks:pick(snapshot.tasks,tasks),artifacts:pick(snapshot.artifacts,artifacts),
    permissions:Object.fromEntries(Object.entries(snapshot.permissions ?? {}).filter(([,value])=>value.status==='pending'||runs.has(value.runId)||!value.status)),
    history:{start,total}};
}
/** Release unrelated terminal metadata together with evicted presentation rows. */
export function retainFlowRows(snapshot, timeline, history = snapshot.history) {
  return {...viewFor(snapshot, timeline, history?.start ?? 0, history?.total ?? timeline.length), ...(history ? {history} : {})};
}
export function flowReplyText(snapshot, {runId,generation}) {
  if(generation!==snapshot.generation||!snapshot.runs[runId])throw new Error('回答版本已变化，请重新打开后复制。');
  return snapshot.timeline.filter(item=>item.kind==='assistant'&&item.runId===runId)
    .flatMap(item=>item.parts.filter(part=>part.kind==='text').map(part=>String(part.content??''))).filter(text=>text.trim()).join('\n\n');
}
// One question and all following answer/process rows form one paging unit.
// Never split a QA because of its row count, bytes or child execution details.
function rangeView(snapshot, end, limit, offset = 0, total = snapshot.timeline.length) {
  const count = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
  let start = end, questions = 0;
  while (start > 0) {
    start--;
    if (snapshot.timeline[start].kind === 'user' && ++questions >= count) break;
  }
  const view = viewFor(snapshot, snapshot.timeline.slice(start, end), offset + start, total);
  if (view.timeline.length && view.timeline[0].kind !== 'user') {
    view.history.continuation = {questionId: view.timeline[0].afterInputId ?? snapshot.history?.continuation?.questionId ?? null};
  }
  return view;
}
export function projectFlowWindow(snapshot, {limit=WINDOW_QAS,start=snapshot.history?.start??0,total=snapshot.history?.total??snapshot.timeline.length}={}) {
  return rangeView(snapshot, snapshot.timeline.length, limit, start, total);
}
export function flowHistoryPage(snapshot, {before,generation,limit=HISTORY_QAS}={}) {
  if (generation!==snapshot.generation || !Number.isSafeInteger(before) || before<0 || before>snapshot.timeline.length)
    throw Object.assign(new Error('历史版本已变化，请重新同步后读取。'),{code:'conflict'});
  const view = rangeView(snapshot, before, limit), start = view.history.start;
  const questionId = view.timeline[0]?.kind === 'user' ? view.timeline[0].id : view.history.continuation?.questionId ?? null;
  return {conversationId:snapshot.conversationId,generation:snapshot.generation,revision:snapshot.revision,start,end:before,total:snapshot.timeline.length,snapshot:view,
    ...(view.history.continuation || snapshot.timeline[before]?.kind === 'assistant' ? {continuation:{questionId,earlier:Boolean(view.history.continuation),later:snapshot.timeline[before]?.kind === 'assistant'}} : {})};
}
function diff(previous,next) {
  if(previous.generation!==next.generation)return {kind:'snapshot',snapshot:next};
  const changes=[],equal=(a,b)=>a===b||JSON.stringify(a)===JSON.stringify(b);
  // Unchanged child transcripts can be large; compare their immutable entries
  // before serializing metadata for every streamed text patch.
  const equalMap=(a={},b={})=>a===b||(Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key])));
  const meta={};for(const key of ['phase','activeRunId','awaitingUser','queuePaused','goal','history'])if(!equal(previous[key],next[key]))meta[key]=next[key];
  if(Object.keys(meta).length)changes.push({kind:'meta',meta});
  if(!equal(previous.pending,next.pending))changes.push({kind:'queue',pending:next.pending});
  const oldIds=previous.timeline.map(itemId),newIds=next.timeline.map(itemId);
  if(oldIds.length>newIds.length || oldIds.some((id,index)=>newIds[index]!==id))changes.push({kind:'timeline',timeline:next.timeline});
  else for(let index=0;index<next.timeline.length;index++) {
    if(index>=previous.timeline.length)changes.push({kind:'item-appended',item:next.timeline[index]});
    else if(!equal(previous.timeline[index],next.timeline[index]))changes.push({kind:'item-updated',item:next.timeline[index]});
  }
  for(const key of ['runs','tasks','artifacts','permissions'])if(!equalMap(previous[key],next[key]))changes.push({kind:key,[key]:next[key]});
  if(!equal(previous.backgroundJobs??[],next.backgroundJobs??[]))changes.push({kind:'background-jobs',jobs:next.backgroundJobs??[]});
  if(!equal(previous.pendingReports,next.pendingReports))changes.push({kind:'reports',pendingReports:next.pendingReports});
  return {kind:'patch',conversationId:next.conversationId,generation:next.generation,baseRevision:previous.revision,revision:next.revision,changes};
}
export function createFlowWindowProjector(applyChange,readSnapshot) {
  const views=new Map();
  return frame=>{
    if(frame.type==='reset') {
      const project=detail=>{const flow=projectFlowWindow(detail.flow);views.set(detail.id,flow);return {...detail,flow};};
      return {...frame,snapshot:{...frame.snapshot,...(frame.snapshot.detail?{detail:project(frame.snapshot.detail)}:{}),...(frame.snapshot.details?{details:frame.snapshot.details.map(project)}:{})}};
    }
    if(frame.type!=='flow')return frame;
    const previous=views.get(frame.id);if(!previous)throw new Error('Flow window has no baseline');
    const applied=applyChange(previous,frame.change);
    if(!applied.ok){
      if(!readSnapshot)throw new Error('Flow window revision gap');
      const fresh=projectFlowWindow(readSnapshot(frame.id));views.set(frame.id,fresh);
      return {...frame,change:{kind:'snapshot',snapshot:fresh}};
    }
    let start=previous.history.start,total=previous.history.total;
    if(frame.change.kind==='snapshot'){start=0;total=applied.snapshot.timeline.length;}
    else for(const group of frame.change.changes)for(const change of group.kind==='multi'?group.changes:[group]) {
      if(change.kind==='timeline'){start=0;total=change.timeline.length;}
      else if(change.kind==='item-appended' && !previous.timeline.some(item=>itemId(item)===itemId(change.item)))total++;
    }
    // Keep a five-QA buffer. Once exceeded, return to ten complete QAs;
    // a burst can reclaim more than five. Output patches keep the boundary.
    const questions=applied.snapshot.timeline.filter(item=>item.kind==='user').length;
    const limit=frame.change.kind==='snapshot'||questions>WINDOW_QAS+RECLAIM_BUFFER_QAS
      ? WINDOW_QAS : WINDOW_QAS+RECLAIM_BUFFER_QAS;
    const next=projectFlowWindow(applied.snapshot,{start,total,limit});views.set(frame.id,next);
    const change=diff(previous,next);
    if(change.kind==='patch'&&frame.change.kind==='patch'){
      const ids=new Set(next.timeline.map(itemId));
      for(const group of frame.change.changes)for(const patch of group.kind==='multi'?group.changes:[group])
        if(patch.kind==='item-updated'&&!ids.has(itemId(patch.item)))change.changes.push(patch);
    }
    return {...frame,change};
  };
}
