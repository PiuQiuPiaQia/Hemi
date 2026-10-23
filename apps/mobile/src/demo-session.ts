import { createConversation, type ConversationTransport, type ConversationLifecycle, type FlowInputView, type FlowSnapshotView, type FlowCommandResult, type ConversationDraftStorage, type ConversationOperationStorage } from '@hemi/conversation-flow/core';
import { initialMessages, demoReply } from './demo';

/** Local simulator for the injected transport. It is never a real Bot connection. */
export function createDemoSession() {
  const scope = { environmentId: 'mobile-offline-demo', conversationId: 'preview' };
  const initial: FlowSnapshotView = {
    schemaVersion: 1, conversationId: scope.conversationId, revision: 0, generation: 1,
    phase: 'idle', activeRunId: null, queuePaused: false, pending: [], tasks: {}, artifacts: {}, permissions: {}, pendingReports: [],
    runs: { welcome: { startedAt: 1792713600000, closedAt: 1792713602000, inputIds: ['welcome-user'] } },
    timeline: [
      { kind: 'user', id: 'welcome-user', runId: 'welcome', text: initialMessages[0].text, inputSource: 'text', attachmentIds: [], acceptedAt: 1792713600000, deliveredAt: 1792713600000 },
      { kind: 'assistant', itemId: 'welcome-assistant', runId: 'welcome', afterInputId: 'welcome-user', parts: initialMessages[1].parts!.map((part, index) => ({ ...part, partId: `welcome-${index}`, kind: part.type, content: 'text' in part ? part.text : '' })) },
    ],
  };
  const key = (kind: string) => `hemi-mobile-demo-v2:${kind}`;
  let snapshot = JSON.parse(sessionStorage.getItem(key('snapshot')) ?? 'null') as FlowSnapshotView | null;
  snapshot ??= initial;
  if (snapshot.phase !== 'idle' && snapshot.activeRunId) {
    snapshot = { ...snapshot, phase: 'idle', queuePaused: true, runs: { ...snapshot.runs,
      [snapshot.activeRunId]: { ...snapshot.runs[snapshot.activeRunId], closedAt: Date.now(), outcome: 'stopped' } }, activeRunId: null };
  }
  const receipts = new Map<string, FlowCommandResult>(JSON.parse(sessionStorage.getItem(key('receipts')) ?? '[]'));
  const receivers = new Set<(change: { kind: 'snapshot'; snapshot: FlowSnapshotView }) => void>();
  const lifecycleReceivers = new Set<Parameters<ConversationLifecycle['subscribe']>[0]>();
  let offline = false, references = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const publish = () => {
    snapshot = { ...snapshot!, revision: snapshot!.revision + 1 };
    sessionStorage.setItem(key('snapshot'), JSON.stringify(snapshot));
    if (!offline) receivers.forEach(receive => receive({ kind: 'snapshot', snapshot: snapshot! }));
  };
  const stopTimer = () => { if (timer !== null) clearInterval(timer); timer = null; };
  function begin(input: FlowInputView) {
    const runId = crypto.randomUUID();
    const itemId = `${runId}:assistant`;
    snapshot = { ...snapshot!, phase: 'running', activeRunId: runId, queuePaused: false,
      pending: snapshot!.pending.filter(item => item.inputId !== input.inputId),
      runs: { ...snapshot!.runs, [runId]: { startedAt: Date.now(), closedAt: null, inputIds: [input.inputId] } },
      timeline: [...snapshot!.timeline,
        { kind: 'user', id: input.inputId, runId, text: input.text, inputSource: input.inputSource, attachmentIds: input.attachmentIds, acceptedAt: Date.now(), deliveredAt: Date.now() },
        { kind: 'assistant', itemId, runId, afterInputId: input.inputId, parts: [] }],
    };
    publish();
    let cursor = 0;
    timer = setInterval(() => {
      cursor = Math.min(cursor + 8, demoReply.length);
      const done = cursor === demoReply.length;
      snapshot = { ...snapshot!, timeline: snapshot!.timeline.map(item => item.kind === 'assistant' && item.itemId === itemId
        ? { ...item, parts: [{ partId: `${itemId}:text`, kind: 'text', content: demoReply.slice(0, cursor) }] } : item),
        ...(done ? { phase: 'idle', activeRunId: null, runs: { ...snapshot!.runs, [runId]: { ...snapshot!.runs[runId], closedAt: Date.now() } } } : {}) };
      publish();
      if (done) { stopTimer(); drain(); }
    }, 60);
  }
  function drain() {
    if (snapshot!.phase !== 'idle' || snapshot!.queuePaused) return;
    const first = snapshot!.pending[0];
    if (first?.state === 'pending') begin(first);
  }
  const transport: ConversationTransport = {
    async fetchSnapshot() { if (offline) throw new Error('Demo disconnected'); return snapshot; },
    subscribe(_scope, receive) { receivers.add(receive); return () => { receivers.delete(receive); }; },
    async lookupOperation(_scope, requestId) { return receipts.get(requestId) ?? null; },
    async command({ command, requestId }) {
      if (offline) throw new Error('Demo disconnected');
      if (receipts.has(requestId)) return receipts.get(requestId)!;
      let result: FlowCommandResult = { ok: true };
      const incoming = command.input as Partial<FlowInputView> | undefined;
      if (command.type === 'send') {
        const input: FlowInputView = { inputId: incoming?.inputId ?? crypto.randomUUID(), editRevision: 0, text: incoming?.text ?? '', inputSource: 'text', attachmentIds: [], state: 'pending' };
        if (snapshot!.phase === 'idle' && !snapshot!.queuePaused) begin(input);
        else { snapshot = { ...snapshot!, pending: [...snapshot!.pending, input] }; publish(); }
        result = { ok: true, inputId: input.inputId };
      } else if (command.type === 'stop') {
        stopTimer();
        const runId = snapshot!.activeRunId;
        snapshot = { ...snapshot!, phase: 'idle', activeRunId: null, queuePaused: true,
          runs: runId ? { ...snapshot!.runs, [runId]: { ...snapshot!.runs[runId], closedAt: Date.now(), outcome: 'stopped' } } : snapshot!.runs };
        publish();
      } else if (command.type === 'rewind') {
        stopTimer();
        const index = snapshot!.timeline.findIndex(item => item.kind === 'user' && item.id === command.targetInputId);
        if (index < 0) return { ok: false, code: 'not-found' };
        snapshot = { ...snapshot!, timeline: snapshot!.timeline.slice(0, index), generation: snapshot!.generation + 1, pending: [], phase: 'idle', activeRunId: null };
        begin({ inputId: crypto.randomUUID(), editRevision: 0, text: incoming?.text ?? '', inputSource: 'text', attachmentIds: [], state: 'pending' });
      } else if (command.type === 'withdrawInput') {
        snapshot = { ...snapshot!, pending: snapshot!.pending.filter(item => item.inputId !== command.inputId) }; publish();
      } else if (command.type === 'resumeQueue') {
        snapshot = { ...snapshot!, queuePaused: false }; publish(); drain();
      } else result = { ok: false, code: 'unsupported', message: '演示通道暂不支持此操作' };
      receipts.set(requestId, result);
      sessionStorage.setItem(key('receipts'), JSON.stringify([...receipts]));
      return result;
    },
  };
  const storageKey = (kind: string, identity: typeof scope) => `${key(kind)}:${JSON.stringify(identity)}`;
  const drafts: ConversationDraftStorage = {
    async load(identity) { return JSON.parse(localStorage.getItem(storageKey('draft', identity)) ?? 'null'); },
    async save(identity, value) { localStorage.setItem(storageKey('draft', identity), JSON.stringify(value)); return { ok: true }; },
  };
  const operations: ConversationOperationStorage = {
    async load(identity) { return JSON.parse(sessionStorage.getItem(storageKey('operations', identity)) ?? 'null'); },
    async save(identity, value) { sessionStorage.setItem(storageKey('operations', identity), JSON.stringify(value)); },
  };
  const lifecycle: ConversationLifecycle = {
    subscribe(receive) {
      lifecycleReceivers.add(receive);
      const visibility = () => receive(document.hidden ? 'suspend' : 'resume');
      document.addEventListener('visibilitychange', visibility);
      return () => { lifecycleReceivers.delete(receive); document.removeEventListener('visibilitychange', visibility); };
    },
  };
  const client = createConversation({ scope, transport, lifecycle, storage: { drafts, operations } });
  return {
    client,
    retain() { references += 1; return () => { references -= 1; queueMicrotask(() => { if (!references) stopTimer(); }); }; },
    setOffline(next: boolean) { offline = next; lifecycleReceivers.forEach(receive => receive(next ? 'offline' : 'online')); },
  };
}
