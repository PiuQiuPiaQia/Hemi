/**
 * 037 记忆服务：分域正文由内嵌 memory-store（Markdown＋control.json 串行提交）
 * 唯一持有，本文件提供请求视图、任务客户端、管理面、对话写入与任务终态提炼。
 * 记忆始终启用，无开关（2026-09-21 裁决）。本文件不 import Electron，离线可测。
 *
 * 保留的原文直读面：设置页「原文（高级）」编辑器与任务回炉的只读全局记忆
 * （readDocuments / saveDocument）直接读写 USER.md / MEMORY.md——store 在下次
 * 读取时按「外部 Markdown 编辑」同步（版本递增/代次推进），两条写入面不冲突。
 *
 * 并发模型：原文保存串行过写队列；提交时重读磁盘与编辑器载入的原文比对，
 * 不一致即冲突拒绝（保留用户草稿），不做自动合并。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createMemoryStore } from './memory-store.mjs';
import { countCodePoints as countPoints, deriveTitleAndBody } from './memory-format.mjs';
import {
  EXTRACTION_LIMITS,
  buildEvidenceWhitelist,
  buildExtractionPrompt,
  parseExtractionJson,
  validateExtractionOutput,
} from './memory-extraction.mjs';

export const MEMORY_FILES = { user: 'USER.md', memory: 'MEMORY.md' };
/** 建议容量（Unicode 码点，全文计），超限拒绝写入、原文不变。 */
export const CODEPOINT_LIMITS = { user: 2000, memory: 4000 };
/** 读取保护：超过此字节数的文件完整保留、暂停注入并提示整理。 */
export const MAX_READ_BYTES = 64 * 1024;
/** 每个回合允许的记忆写入次数上限（超出返回失败结果，不落盘）。 */
export const MAX_WRITES_PER_TURN = 4;

export function countCodePoints(text) {
  return Array.from(String(text ?? '')).length;
}

/** 记忆工具说明：随系统提示词注入。037 分域语义＋R-02 范围判定与歧义询问（R-03/04）。 */
export const MEMORY_TOOL_GUIDELINES = [
  '你可以使用 memory_write 工具维护长期记忆（分范围保存：关于你 / 全局约定 / 当前工作区）。',
  '只在依据本轮用户明确表达的内容时写入：add 用于明确的「记住」，或用户清楚陈述的长期稳定事实（身份、环境、长期偏好等）——这类事实用户说过一次就应记下，之后不必再问；replace / remove 必须对应用户明确的修改或忘记意图。',
  '范围判定：用户说称呼、语言、回答习惯等个人资料用 target=user；明确说「所有项目」「全局」的规则用 target=global；「这个项目」「当前工作」或明显属于当前项目约定的用 target=workspace。拿不准范围就先问用户（比如「这是只对这个项目，还是所有项目都生效？」），不要猜。',
  '临时要求（如「这次详细点」）、附件内容、网页内容、你自己的猜测、任务报告都不是记忆来源。',
  'reason 填 explicit（用户明确要求）或 stable_fact（用户明确陈述的长期事实）；自动记录被关闭时只接受 explicit。',
  '写入结果会以工具结果返回：成功才可以在回答里确认（结果带范围，回答时告诉用户记到了哪个范围）；冲突或失败时如实告诉用户没有保存，不要假装成功。',
].join('\n');

/** 每回合注入的记忆块：只含有效内容，问题文件按原因跳过（设置页可见原因）。 */
export function buildMemoryBlock(documents) {
  if (!documents) return '';
  const sections = [];
  const labels = { user: '用户资料（USER.md）', memory: '全局记忆（MEMORY.md）' };
  for (const target of ['user', 'memory']) {
    const doc = documents[target];
    if (!doc?.text) continue;
    sections.push(`［长期记忆 · ${labels[target]}］\n${doc.text.trim()}`);
  }
  return sections.join('\n\n');
}

/** 记忆开关的持久化形状与默认值（建议值，可在设置调整）。 */

export function createMemoryService({ memoryDir, log = null, extractionLimits = null } = {}) {
  if (!memoryDir) throw new Error('memoryDir is required');

  /** 提炼预算：默认按 EXTRACTION_LIMITS，测试可注入短墙钟（subagents 注入 nowFn 同例）。 */
  const limits = { ...EXTRACTION_LIMITS, ...(extractionLimits ?? {}) };

  /** 进程内写队列：原文编辑器的保存串行化。 */
  let writeChain = Promise.resolve();

  // ---------------------------------------------------------------- 037 分域层（Phase B）
  // store 是分域正文的唯一所有者；原文编辑面（readDocuments / saveDocument）
  // 直接读写两份 Markdown，store 在下次读取时按「外部 Markdown 编辑」同步
  // （版本递增/代次推进），两条写入面不冲突（storage-and-contracts §提交与外部编辑）。
  const store = createMemoryStore({ memoryDir, log });
  /** 每请求记忆投影的码点预算（storage-and-contracts §容量与读取预算）。 */
  const VIEW_BUDGET_CODEPOINTS = 16000;
  const GLOBAL_USER = { kind: 'global', target: 'user' };
  const GLOBAL_FACTS = { kind: 'global', target: 'facts' };

  let scopedReadyPromise = null;
  function ensureScopedReady() {
    if (!scopedReadyPromise) scopedReadyPromise = store.ensureReady();
    return scopedReadyPromise;
  }

  function domainScopeOf(workspaceId) {
    return { kind: 'workspace', workspaceId: workspaceId || 'default' };
  }

  /** 视图分片渲染：按单条预算（完整保留或整条省略并计数），组头只随首条保留出现。 */
  function renderViewSections({ userDoc, factsDoc, domainDoc }) {
    const sections = [];
    let used = 0;
    let omitted = 0;
    /** labelState 跟踪组头是否已输出；loose 文本视作一块。 */
    const pushBlock = (labelState, text) => {
      if (!text || !text.trim()) return;
      const size = countPoints(text) + 20;
      if (used + size > VIEW_BUDGET_CODEPOINTS) {
        omitted += 1;
        return;
      }
      used += size;
      sections.push(labelState.headered ? text : `${labelState.label}\n${text}`);
      labelState.headered = true;
    };
    const entryBlocks = (doc) => (doc?.data?.entries ?? [])
      .map((e) => (e.body ? `- ${e.title}：${e.body}` : `- ${e.title}`));
    const looseText = (doc) => (doc?.data?.loose?.segments ?? []).map((s) => s.text).join('\n');

    const userLabel = { label: '［关于你 · 用户资料（全局生效）］', headered: false };
    pushBlock(userLabel, looseText(userDoc));
    for (const block of entryBlocks(userDoc)) pushBlock(userLabel, block);

    const factsLabel = { label: '［全局约定（所有工作区生效）］', headered: false };
    // MEMORY 未包裹片段一律按待整理处理，不送入任何投影视图（R-12）；整理入口在设置页。
    for (const block of entryBlocks(factsDoc)) pushBlock(factsLabel, block);

    if (domainDoc?.ok) {
      const domainLabel = { label: `［工作区记忆（${domainScopeLabel(domainDoc.data.scope)}）］`, headered: false };
      for (const block of entryBlocks(domainDoc)) pushBlock(domainLabel, block);
    }
    return { sections, omitted };
  }

  function domainScopeLabel(scope) {
    if (scope?.workspaceId === 'default') return '默认空间';
    return `项目 ${scope?.workspaceId ?? ''}`;
  }

  /**
   * 037 R-01/R-05：请求视图。绑定工作区＝global/user + global/facts(条目) + 本域；
   * 未绑定（workspaceId null）落默认空间域。lease 供桥做过期判定。
   */
  async function buildView({ workspaceId = null, includeWorkingRecords = false } = {}) {
    const gate = await ensureScopedReady();
    if (!gate.ok) return gate;
    const domain = domainScopeOf(workspaceId);
    const [userDoc, factsDoc, domainDoc, records] = await Promise.all([
      store.readScope(GLOBAL_USER),
      store.readScope(GLOBAL_FACTS),
      store.readScope(domain),
      includeWorkingRecords ? store.readWorkingRecords({ scope: domain }) : Promise.resolve(null),
    ]);
    if (!userDoc.ok) return userDoc;
    if (!factsDoc.ok) return factsDoc;
    if (!domainDoc.ok && domainDoc.code !== 'unreadable') return domainDoc;
    const { sections, omitted } = renderViewSections({
      userDoc,
      factsDoc,
      domainDoc: domainDoc.ok ? domainDoc : null,
    });
    if (records?.ok) {
      const pad = (records.data.scratchpad.records ?? []).filter((r) => r.type === 'todo' && !r.done);
      if (pad.length) sections.push(`［工作区便签 · 待办］\n${pad.map((r) => `- ${r.text}`).join('\n')}`);
      for (const day of records.data.daily ?? []) {
        sections.push(`［工作记录 · ${day.date}］\n${day.records.map((r) => `- ${r.text}`).join('\n')}${day.omitted ? `\n（另有 ${day.omitted} 条超预算省略，可用 memory_read 查看）` : ''}`);
      }
    }
    const lease = {
      domain: scopeKeyOf(domain),
      scopes: {
        'global/user': { revision: userDoc.data.revision, epoch: userDoc.data.epoch },
        'global/facts': { revision: factsDoc.data.revision, epoch: factsDoc.data.epoch },
        ...(domainDoc.ok ? { [scopeKeyOf(domain)]: { revision: domainDoc.data.revision, epoch: domainDoc.data.epoch } } : {}),
      },
    };
    return {
      ok: true,
      data: {
        text: sections.join('\n\n'),
        lease,
        omittedCount: omitted,
        codepoints: countPoints(sections.join('\n\n')),
      },
    };
  }

  function scopeKeyOf(scope) {
    if (scope?.kind === 'global') return `global/${scope.target}`;
    return `workspace/${scope?.workspaceId ?? ''}`;
  }

  /**
   * 037：任务/请求专属客户端。冻结作用域身份（模型不能改绑定）；run 可读写
   * 本域，verify/closure 只读（写入被拒，服务层兜底——门控免问清单之外的第二道闸）。
   */
  function bindTaskClient({ workspaceId = null, mode = 'run', taskRef = null } = {}) {
    const domain = domainScopeOf(workspaceId);
    const writable = mode === 'run';
    // 任务受理＝新的有效用户来源（037 D）：登记单调序号（fire-and-forget；
    // 提炼校验以作业快照为准，这里保证来源账本不缺账）。
    if (writable) void store.allocateSourceSeq().catch(() => {});
    const state = { epochSeq: 0, degraded: null, lastLease: null };
    const denyWrites = () => failResult('scope_denied', `${mode} 模式为只读，不能写记忆`);
    const client = {
      mode,
      taskRef,
      domain,
      /** 桥的 restore/清单需要直达 store（只读＋受限恢复，均在 store 自身校验内）。 */
      store,
      get domainKey() {
        return scopeKeyOf(domain);
      },
      scopeLabel: domainScopeLabel(domain),
      noteDegraded(message) {
        state.degraded = String(message ?? '视图构建异常');
      },
      async buildView(options) {
        const view = await buildView({ workspaceId: domain.workspaceId, includeWorkingRecords: true, ...options });
        if (!view.ok) {
          state.degraded = view.message;
          return view;
        }
        state.degraded = null;
        return view;
      },
      async addEntry(params) {
        if (!writable) return denyWrites();
        if (state.degraded) return failResult('storage_error', `记忆视图处于降级状态（${state.degraded}），写入被拒绝`);
        // scope 放最后：调用方（含模型工具参数）不能覆盖绑定域。
        return store.addEntry({ ...params, scope: domain });
      },
      async replaceEntry(params) {
        if (!writable) return denyWrites();
        if (state.degraded) return failResult('storage_error', `记忆视图处于降级状态（${state.degraded}），写入被拒绝`);
        return store.replaceEntry({ scope: params?.scope ?? domain, ...params });
      },
      async removeEntry(params) {
        if (!writable) return denyWrites();
        return store.removeEntry({ scope: params?.scope ?? domain, ...params });
      },
      async searchEntries({ query, includeGlobal = true }) {
        const targets = includeGlobal ? [GLOBAL_USER, GLOBAL_FACTS, domain] : [domain];
        const needle = String(query ?? '').trim().toLowerCase();
        if (!needle) return { ok: true, data: { matches: [] } };
        const matches = [];
        for (const scope of targets) {
          const doc = await store.readScope(scope);
          if (!doc.ok) continue;
          for (const entry of doc.data.entries) {
            const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
            if (haystack.includes(needle)) {
              matches.push({ ...entry, scope, scopeLabel: scope.kind === 'global' ? (scope.target === 'user' ? '关于你' : '全局约定') : domainScopeLabel(scope) });
            }
          }
        }
        return { ok: true, data: { matches } };
      },
      async appendWorkingRecord(params) {
        if (!writable) return denyWrites();
        if (state.degraded) return failResult('storage_error', `记忆视图处于降级状态（${state.degraded}），写入被拒绝`);
        return store.appendWorkingRecord({ ...params, scope: domain });
      },
      readWorkingRecords: () => store.readWorkingRecords({ scope: domain }),
      updateScratchpad: (params) => (writable ? store.updateScratchpad({ scope: domain, ...params }) : Promise.resolve(denyWrites())),
      get degraded() {
        return state.degraded;
      },
      get lastLease() {
        return state.lastLease;
      },
      /** 桥投影用：当前视图代次序号（任一涉及域的 epoch 推进即 +1）。 */
      get viewEpoch() {
        return state.epochSeq;
      },
      /**
       * 每次投影后调用：与上一次 lease 比较各域 epoch，有推进则序号 +1，
       * 随后把本次 lease 记为新的比较基线。旧 memory_read 结果按此序号判过期。
       */
      noteEpoch(lease) {
        let bumped = false;
        if (state.lastLease && lease) {
          for (const [key, info] of Object.entries(lease.scopes)) {
            const before = state.lastLease.scopes[key];
            if (!before || before.epoch !== info.epoch) bumped = true;
          }
        }
        if (bumped) state.epochSeq += 1;
        if (lease) state.lastLease = lease;
        return state.epochSeq;
      },
    };
    return client;
  }

  function failResult(code, message) {
    return { ok: false, code, message };
  }

  // ---------------------------------------------------------------- 037 管理面（Phase C）
  // 设置页条目管理入口：查看范围由用户主动选择（可以看别的域，不改变对话/任务
  // 绑定）；变更广播只在持久提交成功后发，不携带原文正文。

  const changeListeners = new Set();

  function parseScope(scope) {
    if (!scope || typeof scope !== 'object') return null;
    if (scope.kind === 'global' && (scope.target === 'user' || scope.target === 'facts')) return scope;
    if (scope.kind === 'workspace' && typeof scope.workspaceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(scope.workspaceId)) return scope;
    return null;
  }

  function notifyChange(info) {
    for (const listener of changeListeners) {
      try {
        listener(info);
      } catch {
        /* 单个订阅者异常不影响其余广播 */
      }
    }
  }

  /** 委派 store 的写操作，成功后广播变更摘要（scope/revision/operationId/条目摘要/来源上下文）。 */
  async function commitAndNotify(scope, action, context = {}) {
    const result = await action();
    if (result?.ok) {
      const key = scopeKeyOf(parseScope(scope) ?? scope);
      const info = key ? store.scopeInfo(key) : null;
      notifyChange({
        scopeKey: key,
        operationId: result.operationId ?? null,
        revision: info?.revision ?? null,
        epoch: info?.epoch ?? null,
        entrySummary: result.data?.entry?.title ?? result.data?.removedEntryId ?? null,
        origin: context.origin ?? null,
        conversationId: context.conversationId ?? null,
        action: context.action ?? null,
        title: context.title ?? result.data?.entry?.title ?? null,
      });
    }
    return result;
  }

  async function listEntries({ scope, query = '', cursor = 0, limit = 50 } = {}) {
    const gate = await ensureScopedReady();
    if (!gate.ok) return gate;
    const parsed = parseScope(scope);
    if (!parsed) return failResult('scope_denied', '未知或非法的记忆范围');
    const doc = await store.readScope(parsed);
    if (!doc.ok) return doc;
    const needle = String(query ?? '').trim().toLowerCase();
    const matched = doc.data.entries
      .filter((e) => !needle || `${e.title}\n${e.body}`.toLowerCase().includes(needle))
      .map((e) => ({
        id: e.id, version: e.version, kind: e.kind, title: e.title, body: e.body,
        sourceRefs: e.sourceRefs, relatedEntryIds: e.relatedEntryIds,
        createdAt: e.createdAt, updatedAt: e.updatedAt, scope: parsed,
      }));
    const start = Math.max(0, Number(cursor) || 0);
    const page = matched.slice(start, start + Math.max(1, Math.min(200, Number(limit) || 50)));
    return {
      ok: true,
      data: {
        scope: parsed,
        revision: doc.data.revision,
        epoch: doc.data.epoch,
        loose: { kind: doc.data.loose.kind, count: doc.data.loose.segments.length, issues: doc.data.issues },
        entries: page,
        total: matched.length,
        nextCursor: start + page.length < matched.length ? start + page.length : null,
      },
    };
  }

  async function mutateEntry({ scope, action = 'add', entryId, expectedVersion, title, body, kind, sourceRefs, relatedEntryIds }, context = {}) {
    const parsed = parseScope(scope);
    if (!parsed) return failResult('scope_denied', '未知或非法的记忆范围');
    if (action === 'add') {
      return commitAndNotify(parsed, () => store.addEntry({ scope: parsed, title, body, kind, sourceRefs, relatedEntryIds }), { ...context, action: 'add', title });
    }
    if (action === 'replace') {
      return commitAndNotify(parsed, () => store.replaceEntry({ scope: parsed, entryId, expectedVersion, title, body, kind, sourceRefs, relatedEntryIds }), { ...context, action: 'replace', title });
    }
    return failResult('invalid_input', 'action 只能是 add 或 replace');
  }

  async function moveEntry({ fromScope, entryId, expectedVersion, toScope }, context = {}) {
    const from = parseScope(fromScope);
    const to = parseScope(toScope);
    if (!from || !to) return failResult('scope_denied', '未知或非法的记忆范围');
    return commitAndNotify(to, () => store.moveEntry({ fromScope: from, entryId, expectedVersion, toScope: to }), { ...context, action: 'move' });
  }

  async function forgetEntry({ scope, entryId, expectedVersion }, context = {}) {
    const parsed = parseScope(scope);
    if (!parsed) return failResult('scope_denied', '未知或非法的记忆范围');
    return commitAndNotify(parsed, () => store.removeEntry({ scope: parsed, entryId, expectedVersion }), { ...context, action: 'forget' });
  }

  async function clearScope({ scope, expectedRevision }, context = {}) {
    const parsed = parseScope(scope);
    if (!parsed) return failResult('scope_denied', '未知或非法的记忆范围');
    if (expectedRevision === undefined) return failResult('invalid_input', '清空范围必须带 expectedRevision（确认时看到的版本）');
    return commitAndNotify(parsed, () => store.clearScope({ scope: parsed, expectedRevision }), { ...context, action: 'clear' });
  }

  async function undoMutation({ operationId, expectedAfterVersion }) {
    const gate = await ensureScopedReady();
    if (!gate.ok) return gate;
    const result = await store.undoMutation({ operationId, expectedAfterVersion });
    if (result?.ok) {
      notifyChange({
        scopeKey: null,
        operationId: result.operationId ?? null,
        revision: null,
        epoch: null,
        entrySummary: result.data?.entry?.title ?? result.data?.entryId ?? null,
        origin: null,
        conversationId: null,
        action: 'undo',
        title: result.data?.entry?.title ?? null,
      });
    }
    return result;
  }

  async function listUndoOperations({ scopeKey } = {}) {
    const gate = await ensureScopedReady();
    if (!gate.ok) return gate;
    return store.listUndoOperations({ scopeKey });
  }

  function subscribeChanges(callback) {
    if (typeof callback !== 'function') return () => {};
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  }

  // ---------------------------------------------------------------- 037 Phase D：任务终态经验提炼
  // 终态后一次有界请求（宿主注入模型调用，服务不管模型/Key）；并发 1、按
  // taskId 去重、队列上限 16。作业开始与提交前都检查收尾摘要开关；不阻塞
  // 任务终态与队列（R-11/R-13）。失败如实记日志，不重试不回扫。

  const extraction = { pending: [], running: false, seq: 0, lastResult: null };

  function scopeLabelForWorkspace(workspaceId) {
    return domainScopeLabel(domainScopeOf(workspaceId));
  }

  async function runExtractionJob(job) {
    const { snapshot, runModel, isExitSummaryEnabled } = job;
    const domainKey = `workspace/${snapshot.workspaceId || 'default'}`;
    const startedAt = Date.now();
    try {
      if ((await isExitSummaryEnabled()) === false) {
        extraction.lastResult = { taskId: snapshot.taskId, code: 'switch_off' };
        return;
      }
      const lease = await store.captureExtractionLease(domainKey);
      if (!lease.ok) {
        log?.warn?.(`[memory-extraction] ${snapshot.taskId} 快照失败：${lease.message}`);
        extraction.lastResult = { taskId: snapshot.taskId, code: lease.code };
        return;
      }
      const prompt = buildExtractionPrompt({
        taskText: snapshot.taskText,
        verdict: snapshot.verdict,
        report: snapshot.report,
        checks: snapshot.checks,
        domainEntries: lease.data.entries,
        workspaceLabel: scopeLabelForWorkspace(snapshot.workspaceId),
      });
      const raw = await runModel({ messages: prompt, signal: job.controller.signal });
      const parsed = parseExtractionJson(raw);
      const validated = validateExtractionOutput(parsed, {
        evidenceWhitelist: buildEvidenceWhitelist({ checks: snapshot.checks }),
        domainEntryIds: lease.data.entries.map((e) => e.id),
      });
      if (!validated.ok) {
        log?.info?.(`[memory-extraction] ${snapshot.taskId} 输出未采纳：${validated.reason}`);
        extraction.lastResult = { taskId: snapshot.taskId, code: 'invalid_output', reason: validated.reason };
        return;
      }
      if (!validated.notes.length && !validated.candidates.length) {
        extraction.lastResult = { taskId: snapshot.taskId, code: 'empty' };
        return;
      }
      if ((await isExitSummaryEnabled()) === false) {
        // 提交前二次检查：作业期间被关闭则不落盘（R-11）。
        extraction.lastResult = { taskId: snapshot.taskId, code: 'switch_off_before_commit' };
        return;
      }
      const commit = await store.commitExtraction({
        scopeKey: domainKey,
        lease: lease.data,
        notes: validated.notes,
        candidates: validated.candidates,
      });
      const ms = Date.now() - startedAt;
      if (commit.ok) {
        log?.info?.(`[memory-extraction] ${snapshot.taskId} 提交 ${ms}ms：notes ${commit.data.appliedNotes}、候选 ${commit.data.appliedCandidates}`);
        notifyChange({
          scopeKey: domainKey,
          operationId: commit.operationId ?? null,
          revision: store.scopeInfo(domainKey)?.revision ?? null,
          epoch: store.scopeInfo(domainKey)?.epoch ?? null,
          entrySummary: validated.candidates[0]?.title ?? null,
          origin: 'task',
          conversationId: snapshot.conversationId ?? null,
          action: validated.candidates.length ? 'add' : 'add',
          title: validated.candidates[0]?.title ?? validated.notes[0]?.text ?? null,
        });
        extraction.lastResult = { taskId: snapshot.taskId, code: 'committed', ms };
      } else {
        log?.info?.(`[memory-extraction] ${snapshot.taskId} 未提交（${commit.code}）：${commit.message}`);
        extraction.lastResult = { taskId: snapshot.taskId, code: commit.code, reason: commit.message };
      }
    } catch (error) {
      // 2026-10-05 会话审计：宿主 chatTurn 被作业 abort 打断时抛的是包装过的
      // 「回合已取消。」（name 不是 AbortError），原先只认 name 会把超时误记成
      // 「失败」——10-05 真机 3 个作业全部以此形态落账。改看作业自己的 signal。
      const aborted = error?.name === 'AbortError' || job.controller?.signal?.aborted === true;
      log?.[aborted ? 'info' : 'warn']?.(
        `[memory-extraction] ${snapshot.taskId} ${aborted ? `超时放弃（${limits.jobTimeoutMs}ms 墙钟）` : `失败：${error?.message ?? error}`}`,
      );
      extraction.lastResult = { taskId: snapshot.taskId, code: aborted ? 'timeout' : 'error', reason: String(error?.message ?? error) };
    }
  }

  function pumpExtractionQueue() {
    if (extraction.running) return;
    const next = extraction.pending.shift();
    if (!next) return;
    extraction.running = true;
    next.controller = new AbortController();
    // 完成即清定时器：60s 墙钟下不清会留悬挂 timer 拖住进程退出窗口。
    const timer = setTimeout(() => next.controller.abort(), limits.jobTimeoutMs);
    runExtractionJob(next)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        extraction.running = false;
        pumpExtractionQueue();
      });
  }

  /**
   * 终态后入队（只排队不 await；调用方 subagents 在终态收口时触发）。
   * snapshot：{ taskId, conversationId?, taskText, verdict, report, checks, workspaceId }。
   * 同 taskId 的排队快照被新终态覆盖（重复终态/核验重试不重复提炼）。
   */
  function scheduleTaskExtraction(snapshot, { runModel, isExitSummaryEnabled }) {
    if (typeof runModel !== 'function' || typeof isExitSummaryEnabled !== 'function') return { ok: false, queued: false };
    const taskId = String(snapshot?.taskId ?? '');
    if (!taskId) return { ok: false, queued: false };
    extraction.pending = extraction.pending.filter((job) => job.snapshot.taskId !== taskId);
    if (extraction.pending.length >= limits.queueLimit) {
      log?.warn?.(`[memory-extraction] 队列已满 ${limits.queueLimit}，丢弃最旧作业`);
      extraction.pending.shift();
    }
    extraction.pending.push({
      snapshot: {
        taskId,
        conversationId: snapshot.conversationId ?? null,
        taskText: String(snapshot.taskText ?? '').slice(0, 300),
        verdict: snapshot.verdict ?? null,
        report: String(snapshot.report ?? ''),
        checks: Array.isArray(snapshot.checks) ? snapshot.checks : [],
        workspaceId: snapshot.workspaceId || null,
      },
      runModel,
      isExitSummaryEnabled,
      controller: null,
    });
    pumpExtractionQueue();
    return { ok: true, queued: true };
  }

  /**
   * 037 C-3：对话侧分域写入（R-01/R-02/R-03）。来源授权沿用 reason 校验
   * （explicit/stable_fact，R-03）；范围由模型按语义选择 target：
   *   'user'＝关于你（全局资料）；'global'＝全局约定；'workspace'＝当前会话
   * 绑定工作区（未绑定落默认空间）。「所有项目」才用 global——
   * 歧义时模型应先反问，服务层不做语义猜测（R-02）。
   * add 条目化（首行标题）；replace/remove 在目标范围内按 oldText 唯一匹配，
   * 多匹配/无匹配如实失败并列候选，不猜测改哪处。
   */
  async function chatMemoryWrite({ workspaceId = null, conversationId = null, action, target, text, oldText, reason, signal } = {}) {
    const reasonError = validateMemoryWriteReason(reason);
    if (reasonError) return { ok: false, error: reasonError };
    if (signal?.aborted) return { ok: false, canceled: true };
    const act = action === 'add' || action === 'replace' || action === 'remove' ? action : null;
    if (!act) return { ok: false, error: 'action 只能是 add、replace 或 remove' };
    let scope;
    if (target === 'user') scope = { kind: 'global', target: 'user' };
    else if (target === 'global') scope = { kind: 'global', target: 'facts' };
    else if (target === 'workspace') scope = domainScopeOf(workspaceId);
    else return { ok: false, error: 'target 只能是 user（关于你）、global（全局约定）或 workspace（当前工作区）' };
    const scopeLabel = scope.kind === 'global'
      ? (scope.target === 'user' ? '关于你' : '全局约定')
      : domainScopeLabel(scope);
    const context = { origin: 'chat', conversationId };

    if (act === 'add') {
      const content = String(text ?? '').trim();
      if (!content) return { ok: false, error: 'add 需要非空的 text' };
      const { title, body } = deriveTitleAndBody(content);
      const result = await mutateEntry({ scope, action: 'add', title, body }, { ...context, title });
      if (!result.ok) {
        return { ok: false, error: result.message, code: result.code, current: result.current };
      }
      return { ok: true, scopeLabel, operationId: result.operationId ?? null, title, unchanged: Boolean(result.unchanged) };
    }

    const needle = String(oldText ?? '').trim();
    if (!needle) return { ok: false, error: `${act} 需要非空的 oldText` };
    const list = await listEntries({ scope, query: needle, limit: 200 });
    if (!list.ok) return { ok: false, error: list.message, code: list.code };
    const matches = list.data.entries.filter((e) => `${e.title}\n${e.body}`.includes(needle));
    if (matches.length === 0) {
      return { ok: false, error: `在${scopeLabel}没有找到匹配的条目；旧版未整理的内容请在设置的记忆页整理后再改`, code: 'invalid_input' };
    }
    if (matches.length > 1) {
      return { ok: false, error: `在${scopeLabel}匹配到 ${matches.length} 条，请给出更完整的原文，或到设置的记忆页操作`, code: 'conflict', candidates: matches.slice(0, 10).map((m) => m.title) };
    }
    const match = matches[0];
    if (act === 'remove') {
      const result = await forgetEntry({ scope, entryId: match.id, expectedVersion: match.version }, { ...context, title: match.title });
      if (!result.ok) return { ok: false, error: result.message, code: result.code, current: result.current };
      return { ok: true, scopeLabel, operationId: result.operationId ?? null, removed: match.title };
    }
    const content = String(text ?? '').trim();
    if (!content) return { ok: false, error: 'replace 需要非空的 text' };
    const { title, body } = deriveTitleAndBody(content);
    const result = await mutateEntry({ scope, action: 'replace', entryId: match.id, expectedVersion: match.version, title, body }, { ...context, title });
    if (!result.ok) return { ok: false, error: result.message, code: result.code, current: result.current };
    return { ok: true, scopeLabel, operationId: result.operationId ?? null, title };
  }

  const filePathFor = (target) => {
    if (!MEMORY_FILES[target]) throw new Error(`未知的记忆文件：${target}`);
    return path.join(memoryDir, MEMORY_FILES[target]);
  };

  const readRaw = (target) => {
    const file = filePathFor(target);
    let stats;
    try {
      stats = statSync(file);
    } catch {
      return { text: null, issue: null }; // 文件不存在＝空记忆（ensureReady 会补建）
    }
    if (!stats.isFile()) return { text: null, issue: 'unreadable' };
    if (stats.size > MAX_READ_BYTES) return { text: null, issue: 'oversized' };
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    } catch {
      return { text: null, issue: 'invalid' };
    }
    return { text, issue: null };
  };

  const atomicWrite = (file, text) => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    try {
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 清不掉不影响判定 */
      }
      throw error;
    }
  };

  /** 启动准备：建目录、缺失才建空文件。读取失败不当空文件。 */
  function ensureReady() {
    mkdirSync(memoryDir, { recursive: true });
    for (const target of Object.keys(MEMORY_FILES)) {
      const file = filePathFor(target);
      if (!statSyncSafe(file)) {
        try {
          writeFileSync(file, '', { encoding: 'utf8' });
        } catch (error) {
          log?.warn?.(`[memory] 初始化 ${MEMORY_FILES[target]} 失败：${error.message}`);
        }
      }
    }
  }

  function statSyncSafe(file) {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  }

  /** 供设置页原文编辑器 / 回炉只读注入：text 为 null 时带 issue 原因（R-09/R-10）。 */
  function readDocuments() {
    const documents = {};
    for (const target of Object.keys(MEMORY_FILES)) {
      const { text, issue } = readRaw(target);
      documents[target] = text === null ? { text: null, issue } : { text, issue: null };
    }
    return documents;
  }

  /**
   * 写队列内执行：磁盘原文与 expected 不一致＝冲突（外部改动或并发写），
   * 返回当前内容；取消检查通过且容量允许才原子落盘。
   */
  function commitDocument({ target, nextText, expectedText, signal }) {
    return enqueue(() => {
      if (signal?.aborted) {
        return { ok: false, canceled: true };
      }
      const current = readRaw(target);
      const onDisk = current.issue ? null : (current.text ?? '');
      if (onDisk === null) {
        return {
          ok: false,
          error: current.issue === 'oversized'
            ? '文件超过 64KiB 读取保护，拒绝写入（请先整理文件）'
            : '文件当前不可读，拒绝写入',
        };
      }
      if (expectedText !== null && onDisk !== expectedText) {
        return { ok: false, conflict: true, current: onDisk };
      }
      const limit = CODEPOINT_LIMITS[target];
      const size = countCodePoints(nextText);
      if (size > limit) {
        return { ok: false, overLimit: true, limit, size };
      }
      try {
        atomicWrite(filePathFor(target), nextText);
      } catch (error) {
        return { ok: false, error: `写入失败：${error.message}` };
      }
      return { ok: true };
    });
  }

  function enqueue(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 设置整文件保存（清空＝保存空文本）；expectedText 是编辑器载入的原文。 */
  async function saveDocument({ target, text, expectedText, signal }) {
    if (!MEMORY_FILES[target]) return { ok: false, error: '未知的记忆文件' };
    const result = await commitDocument({
      target,
      nextText: String(text ?? ''),
      expectedText: expectedText === null ? null : String(expectedText ?? ''),
      signal,
    });
    if (result.conflict) {
      return { ok: false, conflict: true, error: '文件已被更新（可能来自对话或外部编辑），草稿已保留' };
    }
    if (result.overLimit) {
      return { ok: false, error: `超出容量上限（${result.limit} 字符，当前 ${result.size}）` };
    }
    return result;
  }

  /** 015 会话新建/切换不触碰记忆；这里只提供调试用的目录清理入口（测试用）。 */
  function resetForTest() {
    rmSync(memoryDir, { recursive: true, force: true });
    ensureReady();
  }

  return {
    ensureReady,
    readDocuments,
    saveDocument,
    resetForTest,
    // 037 分域层：请求视图与任务客户端（Phase B）。
    buildView,
    bindTaskClient,
    // 037 管理面（Phase C）：条目列表/变更/范围调整/遗忘/撤销与变更订阅。
    listEntries,
    mutateEntry,
    moveEntry,
    forgetEntry,
    clearScope,
    undoMutation,
    listUndoOperations,
    subscribeChanges,
    // 037 C-3：对话侧分域写入（R-01/02/03/08）。
    chatMemoryWrite,
    // 037 Phase D：任务终态经验提炼（队列化，宿主注入模型调用与开关读取）。
    scheduleTaskExtraction,
    get extractionStats() {
      return { pending: extraction.pending.length, running: extraction.running, lastResult: extraction.lastResult };
    },
    get memoryDir() {
      return memoryDir;
    },
  };
}

/** reason 校验：显式要求 / 自动新增的稳定事实，两类之外拒绝。 */
export function validateMemoryWriteReason(reason) {
  if (reason !== 'explicit' && reason !== 'stable_fact') {
    return 'reason 只能是 explicit 或 stable_fact';
  }
  return null;
}
