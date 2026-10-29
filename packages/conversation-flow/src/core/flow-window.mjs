/** Portable view projection: execution and all historical data stay authoritative in the Host. */
const itemId = item => item.kind === 'user' ? item.id : item.itemId;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
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
export function projectFlowWindow(snapshot, {limit=32,maxBytes=256*1024,start=snapshot.history?.start??0,total=snapshot.history?.total??snapshot.timeline.length}={}) {
  const end=start+snapshot.timeline.length;
  const endCount=Math.max(1,Math.min(limit,snapshot.timeline.length));
  let low=1,high=endCount,keep=endCount;
  let offset=Math.max(0,snapshot.timeline.length-keep),timeline=snapshot.timeline.slice(offset);
  let view=viewFor(snapshot,timeline,start+offset,total);
  // The byte budget is soft for one oversized row; active output stays visible.
  if(timeline.length>1 && bytes(view)>maxBytes) {
    keep=1;
    while(low<=high){const middle=Math.floor((low+high)/2),candidate=snapshot.timeline.slice(-middle);
      const candidateView=viewFor(snapshot,candidate,end-middle,total);
      if(bytes(candidateView)<=maxBytes){keep=middle;low=middle+1;}else high=middle-1;
    }
    offset=snapshot.timeline.length-keep;timeline=snapshot.timeline.slice(offset);view=viewFor(snapshot,timeline,start+offset,total);
  }
  return {...view,history:{start:timeline.length?start+offset:end,total}};
}
export function flowHistoryPage(snapshot, {before,generation,limit=32,maxBytes=256*1024}={}) {
  if (generation!==snapshot.generation || !Number.isSafeInteger(before) || before<0 || before>snapshot.timeline.length)
    throw Object.assign(new Error('历史版本已变化，请重新同步后读取。'),{code:'conflict'});
  const end=before;let start=Math.max(0,end-Math.max(1,Math.min(100,limit)));
  let view=viewFor(snapshot,snapshot.timeline.slice(start,end),start,snapshot.timeline.length);
  // Progress even when one individual item is larger than a normal page.
  while(end-start>1 && bytes(view)>maxBytes){start++;view=viewFor(snapshot,snapshot.timeline.slice(start,end),start,snapshot.timeline.length);}
  return {conversationId:snapshot.conversationId,generation:snapshot.generation,revision:snapshot.revision,start,end,total:snapshot.timeline.length,snapshot:view};
}
function diff(previous,next) {
  if(previous.generation!==next.generation)return {kind:'snapshot',snapshot:next};
  const changes=[],equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const meta={};for(const key of ['phase','activeRunId','awaitingUser','queuePaused','history'])if(!equal(previous[key],next[key]))meta[key]=next[key];
  if(Object.keys(meta).length)changes.push({kind:'meta',meta});
  if(!equal(previous.pending,next.pending))changes.push({kind:'queue',pending:next.pending});
  const oldIds=previous.timeline.map(itemId),newIds=next.timeline.map(itemId);
  if(oldIds.length>newIds.length || oldIds.some((id,index)=>newIds[index]!==id))changes.push({kind:'timeline',timeline:next.timeline});
  else for(let index=0;index<next.timeline.length;index++) {
    if(index>=previous.timeline.length)changes.push({kind:'item-appended',item:next.timeline[index]});
    else if(!equal(previous.timeline[index],next.timeline[index]))changes.push({kind:'item-updated',item:next.timeline[index]});
  }
  for(const key of ['runs','tasks','artifacts','permissions'])if(!equal(previous[key],next[key]))changes.push({kind:key,[key]:next[key]});
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
    const next=projectFlowWindow(applied.snapshot,{start,total});views.set(frame.id,next);
    const change=diff(previous,next);
    if(change.kind==='patch'&&frame.change.kind==='patch'){
      const ids=new Set(next.timeline.map(itemId));
      for(const group of frame.change.changes)for(const patch of group.kind==='multi'?group.changes:[group])
        if(patch.kind==='item-updated'&&!ids.has(itemId(patch.item)))change.changes.push(patch);
    }
    return {...frame,change};
  };
}
