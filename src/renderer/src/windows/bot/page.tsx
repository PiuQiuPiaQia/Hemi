import {DirectoryControlButton} from '@hemi/conversation-flow/controls';
import { retainedDeliverables } from '../voice/lib/retained-deliverables';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnectionWarning } from '@hemi/conversation-flow/react';
import { Check, Clock3, Folder, QrCode, Server, ShieldCheck } from 'lucide-react';
import type {
  BotBridge,
  BotDetail,
  BotDirectory,
  BotDraft,
  BotState,
} from '@shared/bot';
import type {
  FlowCommandResult,
  FlowSnapshotView,
  MessageAttachmentView,
  MessageReferenceView,
  SkillSelectionView,
  ThinkingLevel,
  TurnQueueState,
  UsageRecord,
} from '@shared/protocol';
import { VoiceScreen } from '../voice/voice-screen';
import { NavRail } from '../voice/nav-rail';
import { AppTopBar } from '../voice/app-top-bar';
import {PermissionRequestCard} from '@hemi/conversation-flow/parts';
import {LoadingState, StateView, StatusNotice, TimedToast} from '@hemi/ui';
import {
  ConversationBridgeContext,
  ConversationEnvironmentContext,
  ConversationEnvironmentIdContext,
  ConversationOnlineContext,
} from '../voice/lib/conversation-bridge';
import { createFlowTimelineProjector } from '../voice/lib/flow-timeline-view';
import { botModelDirectory, createBotConversationBridge } from './bridge';
import { botInputCurrent, botInputObserved, projectPendingBotInputs, type PendingBotInput } from './pending-input';
import { useClipboardCopy } from '@/lib/use-clipboard-copy';
import {
  BotButton,
  BotDialog,
  BotFolderPicker,
  BotSetup,
} from './dialogs';
import { BotPairing } from './pairing';
import './styles.css';
const EMPTY_STATE: BotState = {
  binding: null,
  online: false,
  error: '',
  busy: '',
  lastConnectedAt: null,
  cache: null,
  candidate: null,
};
const emptyDraft = (): BotDraft => ({
  text: '',
  revision: 0,
  references: [],
  skills: [],
  attachmentIds: [],
});
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ModelSavedToast({ api, instanceId, requestId }: { api: BotBridge; instanceId: string; requestId: string }) {
  return createPortal(<TimedToast icon={<Check aria-hidden="true"/>} onExpire={() => {
    // A late acknowledgement must not clear a newer model operation.
    void api.command('models.dismiss', {expectedInstanceId: instanceId, requestId}).catch(() => {});
  }}>模型已保存</TimedToast>, document.body);
}

export function BotPage({
  onOpenSettings,
}: {
  onOpenSettings: (models?: boolean, environment?: 'local' | 'bot') => void;
}) {
  const api = window.hemiVoice.bot;
  const [state, setState] = useState<BotState>(EMPTY_STATE),
    [loaded, setLoaded] = useState(false),
    [id, setId] = useState<string | null>(null),
    [detail, setDetail] = useState<BotDetail | null>(null),
    [error, setError] = useState(''),
    [panel, setPanel] = useState<string | null>(null),
    [sending, setSending] = useState(false),
    [submittingDraft, setSubmittingDraft] = useState<{id: string; revision: number} | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [uploadJobs, setUploadJobs] = useState<
      Record<
        string,
        { requestId: string; phase: 'uploading' | 'failed'; error?: string }
      >
    >({}),
    [draftVersion, bumpDraft] = useState(0),
    [queueEditing, setQueueEditing] = useState<{
      id: string;
      inputId: string;
      revision: number;
      previous: BotDraft;
    } | null>(null),
    [unknownSend, setUnknownSend] = useState<PendingBotInput | null>(null),
    [pendingInputs, setPendingInputs] = useState<PendingBotInput[]>([]),
    [recoveredEdit, setRecoveredEdit] = useState<PendingBotInput | null>(null),
    [failedSend, setFailedSend] = useState<PendingBotInput | null>(null);
  const {copy: copyRecovery, toastNode: recoveryToast} = useClipboardCopy();
  const showConnectionWarning = useConnectionWarning(!state.online, state.binding?.instanceId ?? '');
  const stateRef = useRef(state),
    idRef = useRef(id),
    alive = useRef(true),
    navigation = useRef(0),
    drafts = useRef(new Map<string, BotDraft>()),
    draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()),
    sendLock = useRef(false);
  const controlWork = useRef<Promise<boolean> | null>(null);
  stateRef.current = state;
  idRef.current = id;
  const bridge = useMemo(
    () =>
      createBotConversationBridge(
        api,
        () => stateRef.current,
        window.hemiVoice,
      ),
    [api, state.binding?.instanceId],
  );
  const project = useMemo(() => createFlowTimelineProjector(), []);
  const currentDetail = state.cache?.details[id ?? ''] ?? detail;
  const current = currentDetail?.id === id ? currentDetail : null;
  const flow = current?.flow ?? null;
  const control = state.cache?.sessions.find(session => session.id === id)?.control;
  const occupied = Boolean(control && control.ownerId !== state.clientId);
  const queued = state.cache?.sessions.find(session => session.id === id)?.status === 'queued';
  const transcripts = useMemo(
    () => {
      if (!flow) return [];
      const rows = projectPendingBotInputs(flow, project(flow).transcripts, pendingInputs);
      return rows.filter(item => !(queued && item.author === 'hemi' && item.flow?.runId === flow.activeRunId && !item.text && !item.parts?.length))
        .map(item => recoveredEdit?.conversationId === id && (item.flow?.inputId ?? item.id) === recoveredEdit.targetInputId
          ? {...item, editDraft: {revision: recoveredEdit.input.inputId, text: recoveredEdit.input.text}} : item);
    },
    [flow, project, queued, pendingInputs, recoveredEdit, id],
  );
  const draft = id
    ? (drafts.current.get(id) ?? current?.draft ?? emptyDraft())
    : emptyDraft();
  void draftVersion;
  const hidingSubmittedDraft = submittingDraft?.id === id && submittingDraft.revision === draft.revision;
  const composerDraft = hidingSubmittedDraft ? {...emptyDraft(), revision: draft.revision} : draft;
  const attachments = current?.attachments ?? [],
    selectedAttachments = attachments.filter((a) =>
      composerDraft.attachmentIds.includes(a.attachmentId),
    );
  const uploadJob = uploadJobs[id ?? ''];
  const uploading = uploadJob?.phase === 'uploading';
  const attachmentError = uploadJob?.error ?? '';
  const blocked =
    !state.online || !state.cache?.enabled || !!unknownSend || !!state.busy || occupied;
  const applyState = useCallback((next: BotState) => {
    if (!alive.current) return;
    if (stateRef.current.binding?.instanceId !== next.binding?.instanceId) {
      drafts.current.clear();
      for (const timer of draftTimers.current.values()) clearTimeout(timer);
      draftTimers.current.clear();
      setUploadJobs({});
      setId(null);
      setDetail(null);
      setEditing(null);
      setQueueEditing(null);
      setUnknownSend(null);
      setPendingInputs([]);
      setRecoveredEdit(null);
      setFailedSend(null);
    }
    const normalized = next.cache
      ? {
          ...next,
          cache: {
            ...next.cache,
            details: Object.fromEntries(
              Object.entries(next.cache.details).map(([key, value]) => {
                const previous = stateRef.current.cache?.details[key];
                return [
                  key,
                  previous?.flow.revision === value.flow.revision &&
                  previous.flow.generation === value.flow.generation
                    ? { ...value, flow: previous.flow }
                    : value,
                ];
              }),
            ),
          },
        }
      : next;
    stateRef.current = normalized;
    setPendingInputs(previous => {
      const next = previous.filter(input => {
        const nextFlow = normalized.cache?.details[input.conversationId]?.flow;
        return input.instanceId === normalized.binding?.instanceId
          && (!nextFlow || (botInputCurrent(nextFlow, input) && !botInputObserved(nextFlow, input)));
      });
      return next.length === previous.length ? previous : next;
    });
    setState(normalized);
    setLoaded(true);
  }, []);
  useEffect(() => {
    alive.current = true;
    let events = 0;
    const off = api.onChanged((next) => {
      events++;
      applyState(next);
    });
    void api
      .getState()
      .then((next) => {
        if (!events) applyState(next);
      })
      .catch((e) => {
        setError(message(e));
        setLoaded(true);
      });
    return () => {
      alive.current = false;
      off();
      for (const timer of draftTimers.current.values()) clearTimeout(timer);
      for (const [key, value] of drafts.current)
        void api
          .command('session.draft', { id: key, ...value })
          .catch(() => {});
      const activeId = idRef.current;
      if (activeId) void api.command('session.control', {id: activeId, action: 'release', controlEpoch: stateRef.current.cache?.sessions.find(item => item.id === activeId)?.control?.epoch}).catch(() => {});
    };
  }, [api, applyState]);
  const call = useCallback(
    async <T,>(
      method: Parameters<BotBridge['command']>[0],
      params: Record<string, unknown> = {},
    ) => {
      const request = {
        ...params,
        expectedInstanceId:
          params.expectedInstanceId ?? stateRef.current.binding?.instanceId,
      };
      if (!api.commandResult) return api.command<T>(method,request);
      // Error custom properties do not survive a thrown contextBridge Error.
      const reply = await api.commandResult<T>(method,request);
      if (!reply.ok) throw Object.assign(new Error(reply.message),{code:reply.code});
      return reply.result;
    },
    [api],
  );
  useEffect(() => {
    if (!id || !state.online) return;
    const identity = state.binding?.instanceId;
    void call<BotDetail>('session.open', { id })
      .then((value) => {
        if (
          alive.current &&
          idRef.current === id &&
          stateRef.current.binding?.instanceId === identity
        )
          setDetail(value);
      })
      .catch((e) => {
        if (alive.current) setError(message(e));
      });
  }, [id, state.online, state.binding?.instanceId, call]);
  async function open(id: string) {
    const seq = ++navigation.current,
      instance = stateRef.current.binding?.instanceId;
    setError('');
    try {
      if (queueEditing) {
        await call('flow.command', {
          id: queueEditing.id,
          command: {
            type: 'finishEditInput',
            inputId: queueEditing.inputId,
            expectedEditRevision: queueEditing.revision,
            cancel: true,
          },
        });
        changeDraftFor(queueEditing.id, queueEditing.previous);
        setQueueEditing(null);
      }
      const data = stateRef.current.online
        ? await call<BotDetail>('session.open', { id })
        : stateRef.current.cache?.details[id];
      if (!data) throw new Error('这条会话尚无本机缓存，恢复连接后可打开。');
      if (
        alive.current &&
        seq === navigation.current &&
        instance === stateRef.current.binding?.instanceId
      ) {
        setDetail(data);
        setId(id);
        setEditing(null);
      }
    } catch (e) {
      setError(message(e));
    }
  }
  async function create() {
    if (blocked) return;
    try {
      const fresh = await call<{ id: string }>('session.create');
      await open(fresh.id);
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    if (!loaded || !state.binding || id) return;
    const first =
      state.cache?.sessions.find((s) => s.id === state.cache?.selectedId) ??
      state.cache?.sessions[0];
    if (first) void open(first.id);
    else if (state.online) void create();
  }, [
    loaded,
    state.binding?.instanceId,
    state.online,
    state.cache?.sessions.length,
    state.busy,
    state.cache?.enabled,
    id,
  ]);
  async function persist(id: string, value: BotDraft) {
    const owner = stateRef.current.cache?.sessions.find(item => item.id === id)?.control;
    if (owner && owner.ownerId !== stateRef.current.clientId) return;
    try {
      await call('session.draft', { id, ...value });
    } catch (e) {
      if (alive.current) setError(message(e));
    }
  }
  function changeDraftFor(target: string, patch: Partial<BotDraft>) {
    const base =
      drafts.current.get(target) ??
      stateRef.current.cache?.details[target]?.draft ??
      detail?.draft ??
      emptyDraft();
    const next = {
      ...base,
      ...patch,
      revision:
        Math.max(
          base.revision,
          stateRef.current.cache?.details[target]?.draft.revision ?? 0,
        ) + 1,
    };
    drafts.current.set(target, next);
    bumpDraft((v) => v + 1);
    const identity = stateRef.current.binding?.instanceId;
    clearTimeout(draftTimers.current.get(target));
    draftTimers.current.set(
      target,
      setTimeout(() => {
        if (identity === stateRef.current.binding?.instanceId)
          void persist(target, next);
      }, 350),
    );
  }
  function changeDraft(patch: Partial<BotDraft>) {
    if (idRef.current) changeDraftFor(idRef.current, patch);
  }
  async function command(
    command: Record<string, unknown>,
    target = idRef.current,
    submission?: PendingBotInput,
  ) {
    if (!target) return null;
    const result = await call<FlowCommandResult>('flow.command', {
      id: target,
      command,
      generation: submission?.generation ?? stateRef.current.cache?.details[target]?.flow.generation,
      ...(submission?.controlEpoch ? {controlEpoch: submission.controlEpoch} : {}),
      ...(submission ? {requestId: submission.requestId} : command.type === 'send'
        ? {
            requestId:
              'send-' + String((command.input as { inputId: string }).inputId),
          }
        : {}),
    });
    if (!result.ok)
      throw Object.assign(new Error(result.message ?? '云端状态已变化，请按当前状态重试。'), {code: result.code});
    return result;
  }
  function makeSubmission(kind: PendingBotInput['kind'], text: string, targetInputId?: string): PendingBotInput {
    const inputId = 'input-' + crypto.randomUUID();
    const original = targetInputId && flow?.timeline.find(item => item.kind === 'user' && item.id === targetInputId);
    const attachmentIds = original && original.kind === 'user' ? original.attachmentIds ?? [] : draft.attachmentIds;
    return {conversationId: id!, instanceId: state.binding!.instanceId, generation: flow!.generation,
      requestId: `${kind}-${inputId}`, kind, targetInputId, draftRevision: kind === 'send' ? draft.revision : undefined,
      controlEpoch: control?.ownerId === state.clientId ? control?.epoch : undefined,
      createdAt: Date.now(), input: {inputId, text, attachmentIds,
        attachmentViews: attachments.filter(item => attachmentIds.includes(item.attachmentId)),
        references: original && original.kind === 'user' ? original.references ?? [] : draft.references,
        skills: original && original.kind === 'user' ? original.skills ?? [] : draft.skills}};
  }
  function submissionIsCurrent(input: PendingBotInput) {
    return alive.current && stateRef.current.binding?.instanceId === input.instanceId;
  }
  function clearSubmittedDraft(input: PendingBotInput) {
    if (input.kind === 'send' && input.draftRevision !== undefined
      && (drafts.current.get(input.conversationId)?.revision ?? input.draftRevision) === input.draftRevision)
      changeDraftFor(input.conversationId, {text: '', attachmentIds: [], references: [], skills: []});
  }
  function failedSubmission(input: PendingBotInput, error: unknown) {
    if (!submissionIsCurrent(input)) return;
    setPendingInputs(previous => previous.filter(item => item.input.inputId !== input.input.inputId));
    const latest = stateRef.current.cache?.details[input.conversationId]?.flow;
    if (latest && botInputObserved(latest, input)) {clearSubmittedDraft(input); return;}
    setError(message(error));
    if (['offline', 'needs-review', 'unknown'].includes((error as {code?: string}).code ?? '')) {
      setUnknownSend(input);
      return;
    }
    if (input.kind === 'rewind') {
      setRecoveredEdit(input);
      if (idRef.current === input.conversationId && latest?.timeline.some(item => item.kind === 'user' && item.id === input.targetInputId))
        setEditing(input.targetInputId!);
    } else setFailedSend(input);
  }
  async function send(text = draft.text) {
    if (!id || !flow || blocked || sendLock.current || uploading) return;
    sendLock.current = true;
    setSending(true);
    setError('');
    const target = id,
      version = draft.revision;
    const submission = queueEditing ? null : makeSubmission('send', text);
    if (submission) {
      setSubmittingDraft({id: target, revision: version});
      setPendingInputs(previous => [...previous, submission]);
    }
    try {
      if (queueEditing) {
        await command(
          {
            type: 'finishEditInput',
            inputId: queueEditing.inputId,
            expectedEditRevision: queueEditing.revision,
            patch: {
              text,
              attachmentIds: draft.attachmentIds,
              references: draft.references,
              skills: draft.skills,
            },
          },
          target,
        );
        changeDraftFor(target, queueEditing.previous);
        setQueueEditing(null);
        bumpDraft((v) => v + 1);
        return;
      }
      await command(
        {
          type: 'send',
          input: submission!.input,
        },
        target,
        submission!,
      );
      if (submissionIsCurrent(submission!)) {clearSubmittedDraft(submission!); setFailedSend(null);}
    } catch (e) {
      if (submission) failedSubmission(submission, e);
      else setError(message(e));
    } finally {
      sendLock.current = false;
      if (alive.current) { setSending(false); setSubmittingDraft(null); }
    }
  }
  async function reconcile() {
    if (!unknownSend) return;
    try {
      await call('connection.reconnect');
      const snapshot = await call<FlowSnapshotView>('flow.snapshot', {
        id: unknownSend.conversationId,
      });
      if (!submissionIsCurrent(unknownSend)) return;
      const found = botInputObserved(snapshot, unknownSend);
      if (found) {
        clearSubmittedDraft(unknownSend);
        setUnknownSend(null);
        setError('');
      } else {
        const receipt = await call<{ status: string; result?: FlowCommandResult }>('operation.get', {
          operationId: unknownSend.requestId,
        });
        if (!submissionIsCurrent(unknownSend)) return;
        if (receipt.status === 'done' && receipt.result?.ok) {
          clearSubmittedDraft(unknownSend); setUnknownSend(null); setError('');
        } else if (receipt.status === 'missing' || receipt.status === 'interrupted' || (receipt.status === 'done' && receipt.result?.ok === false)) {
          const input = unknownSend;
          setUnknownSend(null);
          failedSubmission(input, Object.assign(new Error(receipt.result?.message ?? '云端确认未受理这次消息，内容已保留，可以重新发送。'), {code: 'rejected'}));
        } else setError('云端仍在核对受理结果，草稿已保留。');
      }
    } catch (e) {
      setError(message(e));
    }
  }
  async function update(patch: Record<string, unknown>) {
    if (!id || !state.online) return;
    try {
      await call('session.update', { id, ...patch });
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }
  async function acceptUploaded(
    target: string,
    attachments: MessageAttachmentView[],
    instance: string | undefined,
  ) {
    if (!alive.current || stateRef.current.binding?.instanceId !== instance)
      return;
    const fresh = await call<BotDetail>('session.open', {
      id: target,
      activate: false,
    });
    if (!alive.current || stateRef.current.binding?.instanceId !== instance)
      return;
    clearTimeout(draftTimers.current.get(target));
    draftTimers.current.delete(target);
    if (idRef.current === target) setDetail(fresh);
    const base = drafts.current.get(target) ?? fresh.draft;
    const next = {
      ...base,
      revision: Math.max(base.revision, fresh.draft.revision) + 1,
      attachmentIds: [
        ...new Set([
          ...base.attachmentIds,
          ...attachments.map((a) => a.attachmentId),
        ]),
      ].slice(0, 3),
    };
    drafts.current.set(target, next);
    await persist(target, next);
    bumpDraft((v) => v + 1);
  }
  async function upload(patch: { filePath?: string; dataUrl?: string }) {
    if (!id || !state.online || uploading) return;
    const target = id,
      instance = state.binding?.instanceId,
      requestId = 'upload-' + crypto.randomUUID();
    setUploadJobs((prev) => ({
      ...prev,
      [target]: { requestId, phase: 'uploading' },
    }));
    try {
      const result = await api.upload({ id: target, ...patch, requestId });
      if (result.attachments?.length)
        await acceptUploaded(target, result.attachments, instance);
      if (alive.current && stateRef.current.binding?.instanceId === instance)
        setUploadJobs((prev) => {
          const next = { ...prev };
          delete next[target];
          return next;
        });
    } catch (e) {
      if (alive.current && stateRef.current.binding?.instanceId === instance)
        setUploadJobs((prev) => ({
          ...prev,
          [target]: { requestId, phase: 'failed', error: message(e) },
        }));
    }
  }
  async function retryUpload() {
    if (!id || !uploadJob || !state.online) return;
    const target = id,
      requestId = uploadJob.requestId,
      instance = state.binding?.instanceId;
    setUploadJobs((prev) => ({
      ...prev,
      [target]: { requestId, phase: 'uploading' },
    }));
    try {
      const result = await api.command<{
        attachments: MessageAttachmentView[];
      }>('attachment.retry', { requestId });
      await acceptUploaded(target, result.attachments, instance);
      setUploadJobs((prev) => {
        const next = { ...prev };
        delete next[target];
        return next;
      });
    } catch (e) {
      setUploadJobs((prev) => ({
        ...prev,
        [target]: { requestId, phase: 'failed', error: message(e) },
      }));
    }
  }
  async function cancelUpload() {
    if (!id || !uploadJob) return;
    await api.command('attachment.cancel', { requestId: uploadJob.requestId });
    setUploadJobs((prev) => ({
      ...prev,
      [id]: {
        requestId: uploadJob.requestId,
        phase: 'failed',
        error: '上传已取消，草稿保留。',
      },
    }));
  }
  async function editQueue(inputId: string) {
    if (!id || blocked || queueEditing) return;
    try {
      const result = await command({ type: 'beginEditInput', inputId });
      const input = result?.input;
      if (!input) return;
      setQueueEditing({
        id,
        inputId,
        revision: input.editRevision,
        previous: structuredClone(draft),
      });
      changeDraft({
        text: input.text,
        attachmentIds: input.attachmentIds ?? [],
        references: input.references ?? [],
        skills: input.skills ?? [],
      });
    } catch (e) {
      setError(message(e));
    }
  }
  async function cancelQueueEdit() {
    if (!queueEditing) return;
    try {
      await command(
        {
          type: 'finishEditInput',
          inputId: queueEditing.inputId,
          expectedEditRevision: queueEditing.revision,
          cancel: true,
        },
        queueEditing.id,
      );
      changeDraftFor(queueEditing.id, queueEditing.previous);
      setQueueEditing(null);
      bumpDraft((v) => v + 1);
    } catch (e) {
      setError(message(e));
    }
  }
  async function editResend(messageId: string, text: string) {
    if (!id || !flow || blocked || sendLock.current) return;
    const submission = makeSubmission('rewind', text, messageId);
    sendLock.current = true;
    setSending(true);
    setEditing(null);
    setRecoveredEdit(null);
    setError('');
    setPendingInputs(previous => [...previous, submission]);
    try {
      await command({
        type: 'rewind',
        targetInputId: messageId,
        input: {...submission.input, inputSource: 'text'},
      }, submission.conversationId, submission);
    } catch (e) {
      failedSubmission(submission, e);
    } finally {sendLock.current = false; if (submissionIsCurrent(submission)) setSending(false);}
  }
  async function retry() {
    const last = [...transcripts].reverse().find((t) => t.author === 'user');
    if (last) await editResend(last.flow?.inputId ?? last.id, last.text);
  }
  async function acquireControl(takeover = false) {
    if (!id || !state.online) return false;
    if (!takeover && control?.ownerId === state.clientId) return true;
    if (controlWork.current) return controlWork.current;
    controlWork.current = (async () => {try {
      const result = await call<{ok: boolean; message?: string}>('session.control', {id, action: takeover ? 'takeover' : 'acquire'});
      if (!result.ok) {setError(result.message ?? '会话已被占用，请先抢占会话。'); return false;}
      setError(''); return true;
    } catch (error) {setError(message(error)); return false;}})().finally(() => {controlWork.current = null;});
    return controlWork.current;
  }
  const queue: TurnQueueState = {
    paused: flow?.queuePaused ?? false,
    items: (flow?.pending ?? [])
      .filter((i) => ['pending', 'editing', 'needs-review'].includes(i.state))
      .map((i) => ({
        queueItemId: i.inputId,
        conversationId: id ?? '',
        text: i.text,
        revision: (i.editRevision ?? 0) + 1,
        dispatchState: i.state === 'editing' ? 'editing' : 'pending',
        error: i.state === 'needs-review' ? '投递结果待核对' : '',
        attachmentIds: i.attachmentIds ?? [],
        references: i.references ?? [],
        skills: i.skills ?? [],
        inputSource: 'text',
        createdAt: i.createdAt ?? 0,
      })),
  };
  const usage: UsageRecord[] = (current?.usage ?? []).map((c) => ({
    source: 'chat',
    role: 'main',
    modelKey: c.modelKey,
    modelName: c.modelName,
    at: c.at,
    input: c.usageDetail?.input ?? 0,
    output: c.usageDetail?.output ?? 0,
    cacheRead: c.usageDetail?.cacheRead ?? 0,
    cacheWrite: c.usageDetail?.cacheWrite ?? 0,
    genMs: c.usageDetail?.genMs ?? 0,
  }));
  const running = !!flow?.activeRunId && flow.phase !== 'idle';
  const currentSession = state.cache?.sessions.find(session => session.id === id);
  const waitingResource = currentSession?.waitingResource;
  const activeTask = state.cache?.sessions.find(session => waitingResource ? currentSession.blockedBy?.includes(session.id) : session.status === 'running');
  const permissions = Object.values(current?.permissions ?? {}).filter(
    (p) => p.status === 'pending',
  );
  const modelsSaved = !state.syncStatus?.automatic && state.syncStatus?.phase === 'confirmed' &&
    !!state.syncStatus.results?.length && state.syncStatus.results.every(result => result.ok);
  const actions = (
    <div className="h-bot-top-actions">
      <span
        className={'h-bot-connection' + (state.online ? ' online' : '')}
        title={state.binding?.host}
        aria-label={
          (state.online ? '已连接 ' : showConnectionWarning ? '连接已断开 ' : '正在连接 ') +
          (state.binding?.host ?? '')
        }
      >
        <i />
        <span>
          {state.online ? '已连接' : showConnectionWarning ? '未连接' : '连接中'} · {state.binding?.host}
        </span>
      </span>
      <button
        className="h-bot-sync"
        aria-label="连接新设备"
        title="连接新设备"
        onClick={() => setPanel('pairing')}
      >
        <QrCode size={14} aria-hidden="true" />
        <span aria-live="polite">{state.cache?.deviceAccess?.pendingCount ? `新设备请求 (${state.cache.deviceAccess.pendingCount})` : '连接新设备'}</span>
      </button>
    </div>
  );
  const banner = (
    <>
      {queued && state.online ? <StatusNotice icon={<Clock3 size={18} aria-hidden="true"/>} title={waitingResource ? '等待资源' : '排队中'} detail={waitingResource ? activeTask ? `「${activeTask.title}」正在使用同一资源，相关操作结束后会自动继续。` : '同一资源正在使用中，相关操作结束后会自动继续。' : activeTask ? `「${activeTask.title}」${activeTask.waitingPermission ? '正在等待确认' : '正在执行'}，结束后会自动开始。` : '消息已受理，轮到后会自动开始。'} actions={activeTask ? <BotButton onClick={() => void open(activeTask.id)}>查看当前任务</BotButton> : null}/> : null}
      {state.syncStatus?.automatic && state.syncStatus.phase === 'sending' ? <StatusNotice>正在配置云端模型…</StatusNotice> : null}
      {state.modelConfigError ? <StatusNotice>{state.modelConfigError}</StatusNotice> : null}
      {state.syncStatus && state.syncStatus.phase !== 'sending' && !modelsSaved &&
        (!state.modelConfigError || state.syncStatus.phase === 'unknown') &&
        (state.syncStatus.phase !== 'confirmed' || state.syncStatus.results?.some(result => !result.ok)) && (
        <StatusNotice>
          <span>
            {state.syncStatus.phase === 'unknown'
              ? '模型配置结果待确认。'
              : state.syncStatus.phase === 'interrupted'
                ? '云端模型配置曾被中断，重新选用时会自动重试。'
                : state.syncStatus.phase === 'not-received'
                  ? '云端尚未完成模型配置，重新选用时会自动重试。'
                  : state.syncStatus.results?.some((r) => !r.ok)
                    ? '部分模型未通过云端验证，原配置保留。'
                    : '模型配置结果待确认。'}
          </span>
          {state.syncStatus.phase === 'unknown' ? (
            <BotButton
              disabled={!state.online}
              onClick={() =>
                void call('models.reconcile').catch((e) => setError(message(e)))
              }
            >
              检查配置状态
            </BotButton>
          ) : (
            <BotButton
              onClick={() =>
                void call('models.dismiss').catch((e) => setError(message(e)))
              }
            >
              知道了
            </BotButton>
          )}
        </StatusNotice>
      )}
      {!state.online && (showConnectionWarning || state.cache?.enabled === false) && (
        <StatusNotice>
          <div>
            <strong>
              {state.cache?.enabled === false
                ? state.stoppedConfirmed?'Bot 已停止':'上次确认：任务执行已停用'
                : '连接已断开，云端可能仍在运行'}
            </strong>
            <p>
              {state.error || '草稿会保留。'}
              {state.lastConnectedAt
                ? ' · 最近同步 ' +
                  new Date(state.lastConnectedAt).toLocaleString()
                : ''}
            </p>
          </div>
          <BotButton
            onClick={() =>
              void call(
                state.cache?.enabled === false
                  ? 'service.start'
                  : 'connection.reconnect',
              ).catch((e) => setError(message(e)))
            }
          >
            {state.cache?.enabled === false ? '启动 Bot' : '重新连接'}
          </BotButton>
        </StatusNotice>
      )}
      {state.online && !state.cache?.enabled && (
        <StatusNotice>
          <strong>任务执行已停用</strong>
          <BotButton
            onClick={() =>
              void call('service.start').catch((e) => setError(message(e)))
            }
          >
            启动 Bot
          </BotButton>
        </StatusNotice>
      )}
      {unknownSend && (
        <StatusNotice>
          <span>提交结果待核对，草稿已保留。</span>
          <BotButton onClick={() => void reconcile()}>核对提交结果</BotButton>
        </StatusNotice>
      )}
      {occupied ? <StatusNotice title="会话已被占用" detail="另一台设备正在使用此会话。抢占后，你可以继续编辑和发送。"
        actions={<><BotButton primary disabled={!state.online || sending} onClick={() => void acquireControl(true)}>抢占会话</BotButton>
          {recoveredEdit?.conversationId === id ? <BotButton onClick={() => void copyRecovery(recoveredEdit.input.text, '已复制保留的消息')}>复制保留的内容</BotButton> : null}</>}/> : null}
      {error && !unknownSend && !(occupied && error.includes('会话已被')) ? <StatusNotice role="alert"><span>{error}</span>
        {(recoveredEdit ?? failedSend)?.conversationId === id ? <BotButton onClick={() => void copyRecovery((recoveredEdit ?? failedSend)!.input.text, '已复制保留的消息')}>复制保留的内容</BotButton> : null}
      </StatusNotice> : null}
      {uploadJob && (
        <div className="h-bot-upload" role="status">
          {uploading ? (
            <>
              <progress aria-label="附件上传进度" />
              正在上传附件到云端…
              <BotButton onClick={() => void cancelUpload()}>取消</BotButton>
            </>
          ) : (
            <>
              <span>{uploadJob.error}</span>
              <BotButton
                disabled={!state.online}
                onClick={() => void retryUpload()}
              >
                重试
              </BotButton>
              <BotButton
                onClick={() =>
                  setUploadJobs((prev) => {
                    const next = { ...prev };
                    if (id) delete next[id];
                    return next;
                  })
                }
              >
                移除
              </BotButton>
            </>
          )}
        </div>
      )}
      {permissions.map((p) => (
          <PermissionRequestCard
            key={p.id}
            request={{...p, kind: p.kind ?? 'action'}}
            taskText={current?.title}
            disabled={!state.online}
            onChooseOption={(value) =>
              void call('permission.decide', {
                id,
                permissionId: p.id,
                value,
              }).catch((e) => setError(message(e)))
            }
            onStop={() =>
              void command({ type: 'stop' }).catch((e) => setError(message(e)))
            }
          />
      ))}
    </>
  );
  return (
    <ConversationEnvironmentContext.Provider value="bot">
      <ConversationEnvironmentIdContext.Provider value={`bot:${state.binding?.instanceId ?? 'unbound'}`}>
      <ConversationOnlineContext.Provider value={state.online}>
        <ConversationBridgeContext.Provider value={bridge}>
          {modelsSaved && state.syncStatus ? <ModelSavedToast
            key={`${state.syncStatus.instanceId}:${state.syncStatus.requestId}`}
            api={api} instanceId={state.syncStatus.instanceId} requestId={state.syncStatus.requestId}
          /> : null}
          {recoveryToast}
          {state.binding && current ? (
            <VoiceScreen
              key={state.binding.instanceId}
              topBarActions={actions}
              composerBanner={banner}
              workspaceControl={
                <DirectoryControlButton className="h33-workspace-chip" chevron={false} icon={<Server size={14} aria-hidden="true"/>}
                  title={`${state.binding.host}:${current?.dir ?? state.cache?.defaultDir}`}
                  disabled={!state.online} onClick={() => setPanel('folder')}
                  text={current?.dir === state.cache?.defaultDir ? '默认空间' : current?.dir.split('/').at(-1) || '默认空间'}
                />
              }
              scopeControl={
                <button
                  className="h37-tool"
                  aria-label="云端访问范围"
                  title="云端访问范围"
                  onClick={() => setPanel('scope')}
                >
                  <ShieldCheck size={16} />
                </button>
              }
              sessionState="idle"
              callActive={false}
              turnPhase={running ? 'thinking' : 'idle'}
              turnStartedAt={
                Number(flow?.runs[flow.activeRunId ?? '']?.startedAt) || null
              }
              runActivity={flow?.runs[flow.activeRunId ?? '']?.activity}
              elapsedSeconds={0}
              callMuted={false}
              dockCollapsed
              onToggleCallMute={() => {}}
              onExpandDock={() => {}}
              turnError=""
              streamingReply=""
              interimText=""
              transcripts={transcripts}
              taskState={null}
              taskSnaps={{}}
              onTaskAction={() =>
                void command({ type: 'stop' }).catch((e) =>
                  setError(message(e)),
                )
              }
              contextState={{ objects: [] }}
              contextBusy={uploading}
              contextError={attachmentError}
              onAttachContext={() => void upload({})}
              onRefreshContext={() => {}}
              onRemoveContext={() => {}}
              errorMessage={error}
              onToggleCall={() => {}}
              onRetryTurn={() => void retry()}
              retryTurnBlocked={
                blocked ? '恢复连接并启动 Bot 后重试' : undefined
              }
              textDraft={composerDraft.text}
              onTextDraftChange={(text) => {if (occupied) return; changeDraft(hidingSubmittedDraft ? {text, attachmentIds: [], references: [], skills: []} : {text}); if (!control) void acquireControl();}}
              onTextSend={() => void send()}
              onStopModelTurn={() =>
                void command({ type: 'stop' }).catch((e) =>
                  setError(message(e)),
                )
              }
              editingMessageId={editing}
              onStartEditMessage={(messageId) => {
                if (!blocked && !sendLock.current) void acquireControl().then(ok => {if (ok) setEditing(messageId);});
              }}
              onCancelEditMessage={() => setEditing(null)}
              onEditResendMessage={(messageId, text) =>
                void editResend(messageId, text)
              }
              textModelBusy={running}
              conversationReadOnly={occupied}
              textPendingSpeech={false}
              textModelReady={!!current?.modelKey}
              voiceModelReady={false}
              onOpenSettings={() => onOpenSettings()}
              onOpenModelSettings={() => onOpenSettings(true, state.cache?.models.find(model => model.key === current?.modelKey)?.source === 'cloud' ? 'bot' : 'local')}
              onNewConversation={() => void create()}
              onOpenConversation={(next) => void open(next)}
              onConversationRemoved={(removed) => {
                if (removed === id) {
                  setId(null);
                  setDetail(null);
                }
              }}
              onConversationRenamed={() => {}}
              currentConversationId={id}
              conversationTitle={current?.title ?? 'Hemi Bot'}
              thinkingLevel={current?.thinking ?? 'default'}
              onThinkingLevelChange={(thinking) => void update({ thinking })}
              onOpenSkillMarket={() => setPanel('capabilities')}
              onOpenWorkflowStudio={() => setPanel('capabilities')}
              attachments={attachments}
              draftAttachments={selectedAttachments}
              attachError={attachmentError}
              onAttachPaste={(dataUrl) => void upload({ dataUrl })}
              onAttachDrop={(filePath) => void upload({ filePath })}
              onRemoveAttachment={(attachmentId) =>
                changeDraft({
                  attachmentIds: draft.attachmentIds.filter(
                    (v) => v !== attachmentId,
                  ),
                })
              }
              inputHistory={transcripts
                .filter((t) => t.author === 'user')
                .map((t) => t.text)
                .reverse()}
              mentionConversationId={id}
              mentionWorkspaceId={id}
              draftReferences={composerDraft.references}
              draftSkills={composerDraft.skills}
              onAddReference={(r) =>
                changeDraft({
                  references: [
                    ...draft.references.filter((v) => v.key !== r.key),
                    r,
                  ],
                })
              }
              onRemoveReference={(key) =>
                changeDraft({
                  references: draft.references.filter((r) => r.key !== key),
                })
              }
              onSetDraftReferences={(references: MessageReferenceView[]) =>
                changeDraft({ references })
              }
              onSetDraftSkills={(skills: SkillSelectionView[]) =>
                changeDraft({ skills })
              }
              queueState={queue}
              queueStoppedIdle={
                !!flow?.queuePaused &&
                !flow?.pending.length &&
                flow?.phase === 'idle'
              }
              onContinueStoppedTask={() => void send('继续任务')}
              onWithdrawQueued={(inputId) =>
                void command({ type: 'withdrawInput', inputId }).catch((e) =>
                  setError(message(e)),
                )
              }
              onEditQueued={(inputId) => void editQueue(inputId)}
              onPromoteQueued={(inputId) =>
                void command({ type: 'promoteInput', inputId }).catch((e) =>
                  setError(message(e)),
                )
              }
              onReorderQueued={(inputId, overInputId, expectedInputIds) =>
                void command({
                  type: 'reorderInput',
                  inputId,
                  overInputId,
                  expectedInputIds,
                }).catch((e) => setError(message(e)))
              }
              onResumeQueue={() =>
                void command({ type: 'resumeQueue' }).catch((e) =>
                  setError(message(e)),
                )
              }
              queueEditing={!!queueEditing}
              queueEditSaving={sending && !!queueEditing}
              onCancelQueueEdit={() => void cancelQueueEdit()}
              modelProfiles={botModelDirectory(state)}
              currentProfileId={current?.modelKey ?? null}
              onSelectModelProfile={(modelKey) => void update({ modelKey })}
              usageRecords={usage}
              usageRunning={running}
              workspaceSendBlocked={blocked || uploading || sending}
              workspaceSendBlockedHint={sending || occupied ? '' : uploading ? '附件上传完成后即可发送' : unknownSend ? '正在确认上一条消息的提交结果' : !state.online ? showConnectionWarning ? '正在恢复 Bot 连接，草稿会保留' : '' : 'Bot 暂时无法接收消息，请检查运行状态'}
              onOpenAccessSettings={() => setPanel('scope')}
              flowDeliverables={
                flow
                  ? {
                      conversationId: flow.conversationId,
                      generation: flow.generation,
                      items: retainedDeliverables(flow).map((a) => ({
                        ...a,
                        host: state.binding?.host,
                      })),
                    }
                  : null
              }
            />
          ) : (
            <main className="voice-shell compact-shell h24-shell min-h-dvh overflow-hidden">
              <AppTopBar title="Hemi Bot" showBrand={false} actions={state.binding ? actions : undefined} />
              <div className="h24-frame">
                <NavRail page="bot" />
                <section className="h-bot-onboarding">
                  {state.binding ? (
                    <StateView kind={state.stoppedConfirmed||state.cache?.enabled===false?'empty':state.online||!showConnectionWarning?'loading':'error'} className="h-bot-welcome" role="status" illustration={<Server size={26} aria-hidden="true"/>} titleAs="h1" title={state.stoppedConfirmed||state.cache?.enabled===false?'Bot 已停止':state.online?'正在读取云端会话…':showConnectionWarning?'Bot 连接已断开':'正在连接 Bot…'} description={state.binding.host} descriptionClassName="h-bot-welcome-host">
                      <div className="h-bot-welcome-actions">
                        <BotButton
                          primary={state.stoppedConfirmed || state.cache?.enabled === false}
                          disabled={!!state.busy}
                          onClick={() =>
                            void call('service.start').catch((e) =>
                              setError(message(e)),
                            )
                          }
                        >
                          启动 Bot
                        </BotButton>
                        <BotButton disabled={!!state.busy} onClick={() => onOpenSettings()}>
                          Bot 设置
                        </BotButton>
                        {!state.online && (showConnectionWarning || state.cache?.enabled === false) && (
                          <BotButton
                            primary={!state.stoppedConfirmed && state.cache?.enabled !== false}
                            disabled={!!state.busy}
                            onClick={() =>
                              void call('connection.reconnect').catch((e) =>
                                setError(message(e)),
                              )
                            }
                          >
                            重新连接
                          </BotButton>
                        )}
                      </div>
                    </StateView>
                  ) : loaded ? (
                    <BotSetup
                      api={api}
                      state={state}
                      onDone={() => setId(null)}
                    />
                  ) : (
                    <LoadingState description="正在读取 Bot 连接…"/>
                  )}
                  {error && (
                    <p className="h-bot-error" role="alert">
                      {error}
                    </p>
                  )}
                </section>
              </div>
            </main>
          )}
          {panel === 'folder' && id && (
            <BotFolderPicker
              online={state.online}
              host={state.binding?.host ?? ''}
              initial={current?.dir ?? state.cache?.defaultDir ?? '~'}
              defaultDir={state.cache?.defaultDir ?? '~'}
              recent={state.cache?.recentDirs}
              load={(target) =>
                call<BotDirectory>('directory.list', { path: target })
              }
              onPick={async (dir) => {
                await call('session.update', { id, dir });
              }}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === 'scope' && (
            <BotDialog
              title="云端访问范围"
              onClose={() => setPanel(null)}
              footer={
                <BotButton onClick={() => setPanel(null)}>完成</BotButton>
              }
            >
              <p className="h-bot-host">
                <ShieldCheck size={16} />
                {state.binding?.host}
              </p>
              <p>文件与命令在云服务器上运行，敏感操作会请求确认。</p>
              <code>{current?.dir}</code>
            </BotDialog>
          )}
          {panel === 'pairing' && (
            <BotPairing
              key={state.binding?.instanceId}
              state={state}
              call={call}
              onClose={() => setPanel(null)}
              onBack={() => setPanel(null)}
            />
          )}
          {panel === 'capabilities' && (
            <BotDialog
              title="云端可用能力"
              onClose={() => setPanel(null)}
              footer={
                <BotButton onClick={() => setPanel(null)}>完成</BotButton>
              }
            >
              <p>
                使用 <code>/</code> 选择当前云端项目的技能，通过 <code>@</code>{' '}
                引用云端文件与会话。
              </p>
              <p className="h-bot-small">
                本机技能、记忆和工作流不会自动同步到云端。
              </p>
            </BotDialog>
          )}
        </ConversationBridgeContext.Provider>
      </ConversationOnlineContext.Provider>
      </ConversationEnvironmentIdContext.Provider>
    </ConversationEnvironmentContext.Provider>
  );
}
