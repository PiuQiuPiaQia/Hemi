import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUnderTest } from './compile.mjs';
const { createConversation, createComposerDraft, createDraftPersistence, createFlowReplica, createConversationPresenter, createConversationTranscriptPresenter, projectConversationQueue } = await moduleUnderTest('../src/core.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const scope = { environmentId: 'test-bot', conversationId: 'same' };
const snapshot = (extra = {}) => ({ schemaVersion: 1, conversationId: 'same', revision: 0, generation: 1, phase: 'idle', activeRunId: null,
  queuePaused: false, pending: [], timeline: [], runs: {}, tasks: {}, artifacts: {}, permissions: {}, pendingReports: [], ...extra });
function fixture(options = {}) {
  let current = snapshot(), receive, event, sequence = 0;
  const commands = [];
  const journal = new Map();
  const key = identity => JSON.stringify(identity);
  const operations = {
    async load(identity) { return structuredClone(journal.get(key(identity)) ?? []); },
    async save(identity, value) { journal.set(key(identity), structuredClone(value)); },
  };
  const client = createConversation({ scope, makeId: () => `id-${++sequence}`, requestTimeoutMs: 40,
    lifecycle: { subscribe(listener) { event = listener; return () => { event = null; }; } },
    transport: {
      async fetchSnapshot() { return current; },
      subscribe(_scope, listener) { receive = listener; return () => { receive = null; }; },
      async command(request) { commands.push(request); return { ok: true }; },
      ...options.transport,
    }, storage: { operations, ...options.storage }, ...options.client,
  });
  return { client, commands, journal, operations, set(value) { current = value; receive?.({kind: 'snapshot', snapshot: value}); }, lifecycle(value) { event?.(value); } };
}

test('controller construction is inert; retention survives StrictMode and disposes subscriptions once', async () => {
  let subscriptions = 0, releases = 0, fetches = 0;
  const {client} = fixture({transport: { subscribe() { subscriptions++; return () => { releases++; }; }, async fetchSnapshot() { fetches++; return snapshot(); } }});
  assert.equal(fetches, 0);
  const release = client.retain(); release(); const second = client.retain(); await tick();
  assert.equal(subscriptions, 1); assert.equal(releases, 0);
  second(); await tick(); assert.equal(releases, 1);
  client.dispose(); assert.equal(releases, 1);
});

test('snapshot/patch recovery preserves the final buffered fact and rejects foreign environments', async () => {
  const waiting = deferred(), published = [];
  const replica = createFlowReplica({conversationId: 'same', fetchSnapshot: () => waiting.promise, publish: value => published.push(value)});
  const pending = replica.refresh();
  replica.receive({kind: 'patch', conversationId: 'same', generation: 1, baseRevision: 0, revision: 1, changes: [{kind: 'queue', pending: [{inputId: 'one', text: 'first', state: 'pending'}]}]});
  replica.receive({kind: 'snapshot', snapshot: snapshot({conversationId: 'foreign', revision: 999})});
  waiting.resolve(snapshot()); await pending;
  assert.equal(published.at(-1).revision, 1); assert.equal(published.at(-1).pending[0].inputId, 'one');
  replica.dispose();
});

test('late snapshot after disposal never publishes or restarts recovery', async () => {
  const waiting = deferred(); let publications = 0;
  const replica = createFlowReplica({fetchSnapshot: () => waiting.promise, publish: () => publications++});
  const pending = replica.refresh(); replica.dispose(); waiting.resolve(snapshot()); await pending;
  assert.equal(publications, 0);
});

test('offline draft sends are queued once per revision, cancellable, and drain in original order', async () => {
  const f = fixture(); await f.client.start(); f.lifecycle('offline');
  f.client.draft.setText('first');
  const a = f.client.sendDraft(), duplicate = f.client.sendDraft();
  assert.equal(a, duplicate); await a;
  assert.equal(f.commands.length, 0);
  f.client.draft.setText('second'); await f.client.sendDraft();
  assert.equal(projectConversationQueue(f.client.getSnapshot().snapshot, f.client.getSnapshot().operations).items.length, 2);
  assert.equal(await f.client.cancelWaiting(f.client.getSnapshot().operations[0].id), true);
  f.lifecycle('online'); await tick(); await f.client.refresh(); await f.client.flushQueue();
  assert.deepEqual(f.commands.map(item => item.command.input.text), ['second']);
  assert.equal(f.client.draft.getSnapshot().text, ''); f.client.dispose();
});

test('acceptance only clears its submitted draft revision; typing during send is retained', async () => {
  const receipt = deferred();
  const f = fixture({transport: {command: () => receipt.promise}}); await f.client.start();
  f.client.draft.setText('sent'); const pending = f.client.sendDraft(); await tick();
  f.client.draft.setText('new draft'); receipt.resolve({ok: true}); await pending;
  assert.equal(f.client.draft.getSnapshot().text, 'new draft'); f.client.dispose();
});

test('lost receipt is not replayed; authoritative input identity reconciles it on reconnect', async () => {
  let sent, calls = 0;
  const f = fixture({transport: {async command(request) { sent = request; calls++; throw Error('Disconnected after write'); }}});
  await f.client.start(); f.client.draft.setText('side effect');
  assert.equal((await f.client.sendDraft()).code, 'unknown');
  await f.client.refresh(); assert.equal(calls, 1); assert.equal(f.client.getSnapshot().operations[0].state, 'unknown');
  f.set(snapshot({revision: 1, pending: [{inputId: sent.command.input.inputId, text: 'side effect', state: 'pending', inputSource: 'text', editRevision: 0, attachmentIds: []}]}));
  await f.client.refresh();
  assert.equal(f.client.getSnapshot().operations[0].state, 'accepted'); assert.equal(calls, 1);
  f.client.dispose();
});

test('restarting a client converts sending into unknown and queries its durable receipt without replay', async () => {
  let calls = 0, lookups = 0;
  const f = fixture();
  await f.operations.save(scope, [{id: 'stable-id', state: 'sending', generation: 1, draftRevision: 1, command: {type: 'stop'}}]);
  const restored = createConversation({scope, storage: {operations: f.operations}, transport: {
    async fetchSnapshot() {return snapshot();}, async command() {calls++; return {ok: true};},
    async lookupOperation(_scope, id) {lookups++; assert.equal(id, 'stable-id'); return {ok: true};},
  }});
  await restored.start(); await restored.refresh();
  assert.equal(calls, 0); assert.ok(lookups >= 1); assert.equal(restored.getSnapshot().operations[0].state, 'accepted');
  restored.dispose(); f.client.dispose();
});

test('unknown outcomes block later local operations until the first receipt is reconciled', async () => {
  let calls = 0;
  const f = fixture({transport: {async command() {calls++; throw Error('Lost receipt');}}}); await f.client.start();
  await f.client.sendCommand({type: 'stop'});
  assert.equal((await f.client.sendCommand({type: 'resumeQueue'})).disposition, 'local-queued');
  await f.client.refresh(); assert.equal(calls, 1); f.client.dispose();
});

test('pending operations from an earlier rewind generation cannot execute against the new history', async () => {
  const f = fixture(); await f.client.start(); f.lifecycle('offline');
  f.client.draft.setText('old generation'); await f.client.sendDraft();
  f.set(snapshot({revision: 2, generation: 2}));
  await f.client.refresh();
  assert.equal(f.commands.length, 0); assert.equal(f.client.getSnapshot().operations[0].result.code, 'conflict'); f.client.dispose();
});

test('journal write failure prevents transmission and preserves the composer', async () => {
  let calls = 0;
  const f = fixture({storage: {operations: {async load() {return [];}, async save() {throw Error('Disk full');}}}, transport: {async command() {calls++; return {ok: true};}}});
  await f.client.start(); f.client.draft.setText('do not lose');
  assert.equal((await f.client.sendDraft()).code, 'storage-failed');
  const state = f.client.getSnapshot();
  assert.deepEqual(createConversationPresenter()(state.snapshot, [], state), [], 'a failed local save must not leave a sent bubble');
  assert.equal(calls, 0); assert.equal(f.client.draft.getSnapshot().text, 'do not lose'); f.client.dispose();
});

test('corrupt operation journal blocks sending rather than silently discarding unknown requests', async () => {
  const f = fixture({storage: {operations: {async load() {return [{id: 'bad', state: 'invented'}];}, async save() {}}}});
  await f.client.start(); assert.equal((await f.client.sendCommand({type: 'stop'})).code, 'storage-failed');
  assert.equal(f.commands.length, 0); f.client.dispose();
});

test('draft hydration races preserve new typing and scope switches discard old async results', async () => {
  const old = deferred(), fresh = deferred(), saved = [];
  const draft = createComposerDraft();
  const persistence = createDraftPersistence({draft, environmentId: 'one', debounceMs: 1000, storage: {
    load: identity => identity.conversationId === 'old' ? old.promise : fresh.promise,
    async save(identity, value) {saved.push({identity, value}); return {ok: true};},
  }});
  const a = persistence.activate('old');
  const b = persistence.activate('new'); draft.setText('typed while loading');
  fresh.resolve({revision: 20, text: 'stored new'}); await b;
  old.resolve({revision: 100, text: 'old conversation'}); await a;
  assert.equal(draft.getSnapshot().text, 'typed while loading');
  await persistence.flush(); assert.equal(saved.at(-1).identity.conversationId, 'new'); assert.ok(saved.at(-1).value.revision > 100);
  await persistence.dispose();
});

test('clearing a new-conversation slot supersedes a previous process revision; queue editing persists original draft', async () => {
  const saved = []; const draft = createComposerDraft();
  const persistence = createDraftPersistence({draft, environmentId: 'one', storage: {
    async load() {return {revision: 50, text: 'old draft'};}, async save(identity, value) {saved.push({identity,value}); return {ok: true};},
  }});
  await persistence.activate('draft-new', 'clear'); assert.equal(draft.getSnapshot().text, ''); assert.ok(saved.at(-1).value.revision > 50);
  draft.setText('original'); draft.beginQueueEdit({text: 'queue edit', attachments: [], references: [], skills: []});
  await persistence.flush(); assert.equal(saved.at(-1).value.text, 'original');
  draft.endQueueEdit(); assert.equal(draft.getSnapshot().text, 'original'); await persistence.dispose();
});

test('request timeout is an unknown outcome and disposal aborts outstanding port waits', async () => {
  const f = fixture({client: {requestTimeoutMs: 5}, transport: {command: () => new Promise(() => {})}});
  await f.client.start(); assert.equal((await f.client.sendCommand({type: 'stop'})).code, 'unknown'); f.client.dispose();
  let signal;
  const g = fixture({transport: {command: (_request, context) => {signal = context.signal; return new Promise(() => {});}}});
  await g.client.start(); const waiting = g.client.sendCommand({type: 'stop'}); await tick(); g.client.dispose(); await waiting;
  assert.equal(signal.aborted, true);
});

test('typing tags during hydration is preserved; attachment cleanup does not block stored text recovery', async () => {
  const pending = deferred(), draft = createComposerDraft();
  const p = createDraftPersistence({draft, environmentId: 'tags', storage: {load: () => pending.promise, async save() {return {ok:true};}}});
  const ready = p.activate('one'); draft.setReferences([{key:'new',kind:'file',name:'new',subtitle:''}]);
  pending.resolve({revision: 4, text:'old', references:[]}); await ready;
  assert.equal(draft.getSnapshot().references[0].key,'new'); await p.dispose();
  const second = createComposerDraft();
  const q = createDraftPersistence({draft:second, environmentId:'tags', persistAttachments:false, storage:{async load(){return {revision:2,text:'restored'};},async save(){return {ok:true};}}});
  const loading=q.activate('two');second.setAttachments([]);await loading;
  assert.equal(second.getSnapshot().text,'restored');await q.dispose();
});

test('draft conflicts pause automatic writes until an explicit keep-local choice', async () => {
  const draft=createComposerDraft();let calls=0;
  const p=createDraftPersistence({draft,environmentId:'conflict',storage:{async load(){return {revision:20,text:'remote'};},async save(){calls++;return calls===1?{ok:true,stale:true,revision:25}:{ok:true};}}});
  await p.activate('one');draft.setText('local');await p.flush();draft.setText('still local');await p.flush();
  assert.equal(calls,1);await p.activate('one','preserve');assert.equal(calls,2);assert.equal(draft.getSnapshot().text,'still local');await p.dispose();
});

test('online submissions serialize acceptance so slow ports cannot reorder inputs', async () => {
  const first=deferred();let count=0;const sent=[];
  const f=fixture({client:{requestTimeoutMs:1000},transport:{async command(request){sent.push(request.command.input.text);return ++count===1?first.promise:{ok:true};}}});
  await f.client.start();f.client.draft.setText('one');const a=f.client.sendDraft();await tick();
  f.client.draft.setText('two');const b=f.client.sendDraft();await tick();assert.deepEqual(sent,['one']);
  first.resolve({ok:true});await Promise.all([a,b]);assert.deepEqual(sent,['one','two']);f.client.dispose();
});

test('an offline restart can restore cached history without treating it as a live connection', async () => {
  const f=fixture({storage:{snapshots:{async load(){return snapshot({revision:8});},async save(){}}},transport:{async fetchSnapshot(){throw Error('Offline');}}});
  await f.client.start();assert.equal(f.client.getSnapshot().snapshot.revision,8);assert.equal(f.client.getSnapshot().connection,'offline');f.client.dispose();
});

test('deleting the active scope discards its unsaved draft before adopting a new slot', async () => {
  const saved=[],draft=createComposerDraft();const p=createDraftPersistence({draft,environmentId:'one',storage:{async load(){return null;},async save(identity,value){saved.push({identity,value});return {ok:true};}}});
  await p.activate('deleted');draft.setText('discard deleted scope');await p.activate('draft-new','clear',{discardPrevious:true});
  draft.setText('new input');await p.flush();assert.ok(saved.every(item=>item.identity.conversationId==='draft-new'));await p.dispose();
});

test('a durable draft token reconciles after restart; equal text with a newer token is retained', async () => {
  for(const matches of [true,false]) {
    let stored={revision:20,token:matches?'submitted-token':'edited-token',text:'same text'};
    const f=fixture({storage:{drafts:{async load(){return stored;},async save(_scope,value){stored=value;return {ok:true};}},operations:{
      async load(){return [{id:'old',state:'sending',generation:1,draftToken:'submitted-token',command:{type:'stop'}}];},async save(){}
    }},transport:{async lookupOperation(){return {ok:true};}}});
    await f.client.start();await f.client.refresh();assert.equal(f.client.draft.getSnapshot().text,matches?'':'same text');f.client.dispose();
  }
});

test('SDK owns optional polling and clears it on disposal', async () => {
  let calls=0;const f=fixture({client:{pollIntervalMs:5},transport:{async fetchSnapshot(){calls++;return snapshot();}}});
  await f.client.start();await new Promise(resolve=>setTimeout(resolve,18));assert.ok(calls>=2);f.client.dispose();
  const stopped=calls;await new Promise(resolve=>setTimeout(resolve,12));assert.equal(calls,stopped);
});

test('a failed save remains available across conversation navigation in the same host', async () => {
  const draft=createComposerDraft();const p=createDraftPersistence({draft,environmentId:'one',storage:{async load(){return null;},async save(){throw Error('Unavailable');}}});
  await p.activate('a');draft.setText('unsaved A');await p.flush();await p.activate('b');draft.setText('draft B');await p.activate('a');
  assert.equal(draft.getSnapshot().text,'unsaved A');await p.dispose();
});

test('a failed durable withdrawal restores the waiting item instead of claiming cancellation succeeded', async () => {
  let fail=false;const f=fixture({storage:{operations:{async load(){return [];},async save(){if(fail)throw Error('Unavailable');}}}});
  await f.client.start();f.lifecycle('offline');f.client.draft.setText('queued');await f.client.sendDraft();fail=true;
  assert.equal(await f.client.cancelWaiting(f.client.getSnapshot().operations[0].id),false);
  assert.equal(f.client.getSnapshot().operations[0].state,'waiting');f.client.dispose();
});

test('explicitly retrying a draft after storage recovery uses the original queued operation', async () => {
  const receipt = deferred();
  let fail=true;const f=fixture({storage:{operations:{async load(){return [];},async save(){if(fail)throw Error('Unavailable');}}},transport:{command:()=>receipt.promise},client:{requestTimeoutMs:5000}});
  await f.client.start();f.client.draft.setText('retry same input');assert.equal((await f.client.sendDraft()).code,'storage-failed');
  const id=f.client.getSnapshot().operations[0].id;fail=false;
  const pending=f.client.sendDraft();await tick();
  const state=f.client.getSnapshot();
  assert.equal(state.operations[0].id,id);assert.equal(state.operations[0].state,'sending');
  assert.equal(createConversationPresenter()(state.snapshot,[],state)[0].text,'retry same input');
  receipt.resolve({ok:true});assert.equal((await pending).ok,true);
  assert.equal(f.client.getSnapshot().operations.length,1);f.client.dispose();
});

test('offline stop/edit operations are rejected rather than silently scheduled for later execution', async () => {
  const f=fixture();await f.client.start();f.lifecycle('offline');
  assert.equal((await f.client.sendCommand({type:'stop'})).code,'offline');
  assert.equal((await f.client.sendCommand({type:'rewind'})).code,'offline');
  assert.equal(f.client.getSnapshot().operations.length,0);assert.equal(f.commands.length,0);f.client.dispose();
});


test('an in-flight message stays visible until the Host snapshot includes its stable input identity', async () => {
  const receipt = deferred();
  const f = fixture({transport: {command: () => receipt.promise}, client: {requestTimeoutMs: 5000}});
  await f.client.start(); f.client.draft.setText('visible immediately');
  const pending = f.client.sendDraft(); await tick();
  const state = f.client.getSnapshot(), queue = projectConversationQueue(state.snapshot, state.operations);
  assert.equal(queue.items[0].text, 'visible immediately');
  assert.equal(queue.items[0].dispatchState, 'sending');
  const inputId = state.operations[0].command.input.inputId;
  f.set(snapshot({revision: 1, timeline: [{kind: 'user', id: inputId}]}));
  assert.equal(projectConversationQueue(f.client.getSnapshot().snapshot, state.operations).items.length, 0);
  receipt.resolve({ok: true}); await pending; f.client.dispose();
});

test('online submission retains its draft without showing a queue before the Host queues it', async () => {
  const receipt = deferred();
  const f = fixture({transport: {command: () => receipt.promise}, client: {requestTimeoutMs: 5000}});
  await f.client.start(); f.client.draft.setText('send directly');
  const queues = [];
  const release = f.client.subscribe(() => {
    const state = f.client.getSnapshot();
    queues.push(projectConversationQueue(state.snapshot, state.operations, state.connection).items);
  });
  const pending = f.client.sendDraft(); await tick();
  assert.ok(queues.length > 0);
  assert.ok(queues.every(items => items.length === 0), 'journal writes and transmission must not flash a queue');
  assert.equal(f.client.draft.getSnapshot().text, 'send directly');
  const inputId = f.client.getSnapshot().operations[0].command.input.inputId;
  f.set(snapshot({revision: 1, pending: [{inputId, text: 'send directly', state: 'pending'}]}));
  assert.equal(queues.at(-1).length, 1, 'only the Host can decide that an online message is queued');
  receipt.resolve({ok: true, disposition: 'queued'}); await pending;
  assert.equal(f.client.draft.getSnapshot().text, '');
  release(); f.client.dispose();
});

test('online messages bridge command acceptance and snapshot delivery without duplicates', async () => {
  const receipt = deferred(), f = fixture({transport: {command: () => receipt.promise}, client: {requestTimeoutMs: 5000}});
  const present = createConversationPresenter();
  const messages = () => {const state = f.client.getSnapshot(); return present(state.snapshot, [], state);};
  await f.client.start(); f.client.draft.setText('show immediately');
  const pending = f.client.sendDraft(); await tick();
  const inputId = f.client.getSnapshot().operations[0].command.input.inputId;
  assert.deepEqual(messages().map(message => [message.id, message.text]), [[inputId, 'show immediately']]);
  assert.equal(messages()[0].actions.edit, false);
  receipt.resolve({ok: true}); await pending;
  assert.equal(f.client.draft.getSnapshot().text, '');
  assert.equal(messages().length, 1, 'receipt before snapshot must not remove the message');
  f.set(snapshot({revision: 1, timeline: [{kind: 'user', id: inputId, text: 'show immediately', runId: 'run', inputSource: 'text'}]}));
  assert.equal(messages().length, 1);
  assert.equal(messages()[0].id, inputId);
  assert.equal(messages()[0].actions.edit, true);
  f.set(snapshot({generation: 2, revision: 2}));
  assert.deepEqual(messages(), [], 'a rewind must not resurrect old accepted inputs');
  f.client.dispose();
});

test('preparing-run status stays after its optimistic input through delivery and first output', () => {
  const present = createConversationPresenter();
  const input = {inputId: 'new-input', text: 'new message'};
  const delivery = {connection: 'online', operations: [{id: 'send', generation: 1, state: 'sending', command: {type: 'send', input}}]};
  const history = [{kind: 'user', id: 'previous-input', text: 'previous message', runId: 'previous-run'}];
  const preparing = snapshot({revision: 1, phase: 'preparing', activeRunId: 'new-run', timeline: history,
    runs: {'new-run': {inputIds: [input.inputId], startedAt: 10}}});
  const waitingId = 'new-run:a:new-input';
  assert.deepEqual(present(preparing, [], delivery).map(row => row.id), ['previous-input', input.inputId, waitingId]);
  delivery.operations[0].state = 'accepted';
  assert.deepEqual(present(preparing, [], delivery).map(row => row.id), ['previous-input', input.inputId, waitingId]);
  const delivered = {...preparing, revision: 2, timeline: [...history, {kind: 'user', id: input.inputId, text: input.text, runId: 'new-run'}]};
  assert.deepEqual(present(delivered, [], delivery).map(row => row.id), ['previous-input', input.inputId, waitingId]);
  const output = {...delivered, revision: 3, phase: 'running', timeline: [...delivered.timeline,
    {kind: 'assistant', itemId: waitingId, runId: 'new-run', parts: [{partId: 'first-output', kind: 'text', content: 'reply'}]}]};
  const rows = present(output, [], delivery);
  assert.deepEqual(rows.map(row => row.id), ['previous-input', input.inputId, waitingId]);
  assert.equal(rows.at(-1).text, 'reply');
});

test('a new optimistic send does not move the status belonging to an earlier active input', () => {
  const present = createConversationPresenter();
  const active = snapshot({phase: 'running', activeRunId: 'active',
    timeline: [{kind: 'user', id: 'current', text: 'current input', runId: 'active'}], runs: {active: {inputIds: ['current']}}});
  const delivery = {connection: 'online', operations: [{id: 'send-next', generation: 1, state: 'sending',
    command: {type: 'send', input: {inputId: 'next', text: 'next input'}}}]};
  assert.deepEqual(present(active, [], delivery).map(row => row.id), ['current', 'active:a:current', 'next']);
  assert.deepEqual(present({...active, revision: 1, pending: [{inputId: 'next', text: 'next input', state: 'pending'}]}, [], delivery).map(row => row.id),
    ['current', 'active:a:current']);
});

test('Host queue takes over optimistic messages and unknown delivery restores recovery without replay', async () => {
  const receipt = deferred(), f = fixture({transport: {command: () => receipt.promise}, client: {requestTimeoutMs: 5000}});
  const present = createConversationPresenter();
  const messages = () => {const state = f.client.getSnapshot(); return present(state.snapshot, [], state);};
  await f.client.start(); f.client.draft.setText('keep recoverable');
  const pending = f.client.sendDraft(); await tick();
  const inputId = f.client.getSnapshot().operations[0].command.input.inputId;
  assert.equal(messages().length, 1);
  f.set(snapshot({revision: 1, pending: [{inputId, text: 'keep recoverable', state: 'pending'}]}));
  assert.deepEqual(messages(), [], 'the actual queue must not also appear as a user bubble');
  f.set(snapshot({revision: 2}));
  assert.deepEqual(messages(), [], 'withdrawn Host inputs must not reappear from the in-flight operation');
  receipt.resolve({ok: false, code: 'unknown'}); await pending;
  assert.deepEqual(messages(), []);
  assert.equal(f.client.draft.getSnapshot().text, 'keep recoverable');
  const state = f.client.getSnapshot();
  assert.equal(projectConversationQueue(state.snapshot, state.operations, state.connection).items[0].error, '投递结果不明，待核对');
  f.client.dispose();
});

test('a withdrawn queued input stays absent after recreating its presenter', () => {
  const state = {connection: 'online', operations: [{id: 'operation', state: 'accepted', generation: 1,
    command: {type: 'send', input: {inputId: 'withdrawn', text: 'already withdrawn'}}, result: {ok: true, disposition: 'queued', revision: 1}}]};
  assert.deepEqual(createConversationPresenter()(snapshot({revision: 2}), [], state), []);
});

test('offline and rejected sends stay drafts; outgoing attachments keep their identities', async () => {
  const receipt = deferred(), f = fixture({transport: {command: () => receipt.promise}, client: {requestTimeoutMs: 5000}});
  const present = createConversationPresenter();
  const messages = () => {const state = f.client.getSnapshot(); return present(state.snapshot, [], state);};
  await f.client.start(); f.lifecycle('offline'); f.client.draft.setText('with an attachment');
  const attachment = {attachmentId: 'file-1', name: 'sample.txt', status: 'ready'};
  f.client.draft.setAttachments([attachment]); await f.client.sendDraft();
  assert.deepEqual(messages(), []);
  f.lifecycle('online'); await tick(); await tick();
  assert.deepEqual(messages()[0].attachments, [attachment]);
  receipt.resolve({ok: false, code: 'denied', message: 'Rejected for verification'});
  await f.client.flushQueue();
  assert.deepEqual(messages(), []);
  assert.equal(f.client.draft.getSnapshot().text, 'with an attachment');
  assert.deepEqual(f.client.draft.getSnapshot().attachments, [attachment]);
  f.client.dispose();
});

test('connection-aware queue preserves offline outbox and unknown delivery warnings', async () => {
  const f = fixture({transport: {async command() {throw Error('Lost receipt');}}});
  await f.client.start(); f.lifecycle('offline');
  f.client.draft.setText('do not lose this message'); await f.client.sendDraft();
  let state = f.client.getSnapshot();
  assert.equal(projectConversationQueue(state.snapshot, state.operations, state.connection).items.length, 1);
  f.client.draft.setText('waiting behind the first message'); await f.client.sendDraft();
  await f.client.refresh();
  state = f.client.getSnapshot();
  assert.equal(state.operations[0].state, 'unknown');
  const queue = projectConversationQueue(state.snapshot, state.operations, state.connection);
  assert.equal(queue.items.length, 2);
  assert.equal(queue.items[0].error, '投递结果不明，待核对');
  assert.equal(queue.items[1].text, 'waiting behind the first message');
  f.client.dispose();
});

test('rewind preview, rollback and cross-device generations use the shared transcript presenter', () => {
  const present = createConversationTranscriptPresenter();
  const user = (id, text) => ({kind: 'user', id, text, runId: id + '-run', inputSource: 'text', attachmentIds: [], deliveredAt: 1});
  const original = snapshot({timeline: [user('prefix', '保留'), user('original', '旧问题'),
    {kind: 'assistant', itemId: 'answer', runId: 'original-run', afterInputId: 'original', parts: [{partId: 'text', kind: 'text', content: '旧回答'}]}]});
  const operation = {id: 'rewind-request', state: 'sending', generation: 1, createdAt: 2,
    command: {type: 'rewind', targetInputId: 'original', input: {inputId: 'replacement', text: '新问题', attachmentViews: [{attachmentId: 'file', name: 'a.txt', status: 'ready'}]}}};
  const state = {operations: [operation], connection: 'online'};
  const before = structuredClone(original);
  const rows = present(original, [], state);
  assert.deepEqual(rows.map(item => item.id), ['prefix', 'replacement']);
  assert.equal(rows[1].pendingDelivery, true);
  assert.equal(rows[1].attachments[0].attachmentId, 'file');
  assert.deepEqual(original, before, 'preview never changes authoritative history');
  const rejected = present(original, [], {...state, operations: [{...operation, state: 'rejected'}]});
  assert.equal(rejected.find(item => item.id === 'original').editDraft.text, '新问题');
  assert.ok(rejected.some(item => item.text === '旧回答'));
  const own = snapshot({generation: 2, revision: 2, runs: {run: {runId: 'run', inputIds: ['replacement']}}});
  assert.ok(present(own, [], state).some(item => item.id === 'replacement'));
  const remote = snapshot({generation: 2, revision: 2, timeline: [user('remote', '另一台设备')], runs: {run: {runId: 'run', inputIds: ['remote']}}});
  assert.deepEqual(present(remote, [], state).map(item => item.id), ['remote']);
});

test('submission freezes the host lease and stop target before asynchronous initialization', async () => {
  let epoch = 'original-lease';
  const f = fixture({transport: {prepareCommand: command => ({...command, controlEpoch: epoch})}});
  await f.client.start();
  f.set(snapshot({revision: 1, phase: 'running', activeRunId: 'original-run'}));
  const stop = f.client.sendCommand({type: 'stop'});
  epoch = 'new-lease';
  f.set(snapshot({revision: 2, phase: 'running', activeRunId: 'new-run'}));
  await stop;
  assert.equal(f.commands[0].command.controlEpoch, 'original-lease');
  assert.equal(f.commands[0].command.targetRunId, 'original-run');
  f.client.dispose();
});

test('a delayed stop receipt does not block an edit from reaching the same Host', async () => {
  const receipt = deferred();
  const f = fixture({client: {requestTimeoutMs: 5000}, transport: {async command(request) {
    f.commands.push(request);
    return request.command.type === 'stop' ? receipt.promise : {ok: true};
  }}});
  await f.client.start();
  f.set(snapshot({revision: 1, phase: 'running', activeRunId: 'old'}));
  const stop = f.client.sendCommand({type: 'stop'}); await tick();
  await f.client.sendCommand({type: 'rewind', targetInputId: 'old-input', input: {text: 'replacement'}});
  assert.deepEqual(f.commands.map(request => request.command.type), ['stop', 'rewind']);
  assert.equal(f.commands[0].command.targetRunId, 'old');
  receipt.resolve({ok: true}); await stop; f.client.dispose();
});

test('an accepted draft token cannot be submitted again while its host draft awaits the receipt', async () => {
  const f = fixture(); await f.client.start();
  f.client.draft.restore({token: 'host-draft:1', text: 'send once'});
  await f.client.sendDraft();
  f.client.draft.restore({token: 'host-draft:1', text: 'send once'});
  await f.client.sendDraft();
  assert.equal(f.commands.length, 1);
  f.client.draft.restore({token: 'host-draft:2', text: 'send once'});
  await f.client.sendDraft();
  assert.equal(f.commands.length, 2, 'a new draft identity may intentionally repeat the text');
  f.client.dispose();
});
