import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, RefreshCw, Search, X } from 'lucide-react';

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type {
  LocalSkillBatchImportResult, LocalSkillCandidate, LocalSkillImportMode, LocalSkillScanResult, SkillActionResult, SkillMarketState,
} from '@shared/protocol';
import './local-skill-import-dialog.css';

/** 导入弹窗的桥接口；扫描发生在本机，远端 Bot 由 bridge 传输文件，不接收本机路径链接。 */
export type LocalSkillImportApi = {
  scanLocalSkills: () => Promise<LocalSkillScanResult>;
  importLocalSkills: (paths: string[], options?: { mode?: LocalSkillImportMode }) => Promise<LocalSkillBatchImportResult>;
  importLocalSkill: (options?: { mode?: LocalSkillImportMode }) => Promise<SkillActionResult>;
};

type Scan =
  | { phase: 'scanning'; candidates: LocalSkillCandidate[] | null; warnings: string[] }
  | { phase: 'ready'; candidates: LocalSkillCandidate[]; warnings: string[] }
  | { phase: 'failed'; reason: string };

type Outcome =
  | { tone: 'ok'; text: string }
  | { tone: 'warn' | 'danger'; text: string };

/** 只为显示缩短家目录；完整路径放在 title 里。 */
function shortPath(value: string) {
  return value.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

/** 后端单次批量导入上限。 */
export const LOCAL_SKILL_BATCH_LIMIT = 50;

const reasonOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

export function LocalSkillImportDialog({ open, api, remote = false, onClose, onState }: {
  open: boolean;
  api: LocalSkillImportApi;
  remote?: boolean;
  /** imported：本次弹窗里是否至少导入成功一个技能。 */
  onClose: (imported: boolean) => void;
  onState: (state: SkillMarketState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const importedRef = useRef(false);
  const close = useCallback(() => {
    if (busy) return;
    onClose(importedRef.current);
  }, [busy, onClose]);
  useEffect(() => { if (open) importedRef.current = false; }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      {/* aria-modal：native-input 的 Tab 圈与 page 的全局快捷键闸门按它识别模态框（base-ui 不输出）。 */}
      <DialogContent className="h71-import" showCloseButton={false} aria-modal="true" aria-busy={busy || undefined}>
        {open ? (
          <ImportPanel
            api={api}
            remote={remote}
            busy={busy}
            setBusy={setBusy}
            onImported={() => { importedRef.current = true; }}
            onState={onState}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportPanel({ api, remote, busy, setBusy, onImported, onState }: {
  api: LocalSkillImportApi;
  remote: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onImported: () => void;
  onState: (state: SkillMarketState) => void;
}) {
  const listId = useId();
  const mode: LocalSkillImportMode = remote ? 'copy' : 'symlink';
  const [scan, setScan] = useState<Scan>({ phase: 'scanning', candidates: null, warnings: [] });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [failures, setFailures] = useState<Map<string, string>>(() => new Map());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [importing, setImporting] = useState<'' | 'batch' | 'folder'>('');
  const scanToken = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const runScan = useCallback(async () => {
    const token = ++scanToken.current;
    setScan((current) => ({
      phase: 'scanning',
      candidates: current.phase === 'failed' ? null : current.candidates,
      warnings: current.phase === 'failed' ? [] : current.warnings,
    }));
    let result: LocalSkillScanResult;
    try {
      result = await api.scanLocalSkills();
    } catch (cause) {
      result = { ok: false, reason: reasonOf(cause, '扫描没有完成') };
    }
    if (!alive.current || token !== scanToken.current) return;
    if (!result.ok) {
      setScan({ phase: 'failed', reason: result.reason || '扫描没有完成' });
      return;
    }
    const candidates = result.candidates ?? [];
    setScan({ phase: 'ready', candidates, warnings: result.warnings ?? [] });
    // 重新扫描后，已导入或已消失的条目不再保留勾选。
    const available = new Set(candidates.filter((item) => !item.installed).map((item) => item.path));
    setPicked((current) => new Set([...current].filter((path) => available.has(path))));
    setFailures((current) => new Map([...current].filter(([path]) => available.has(path))));
  }, [api]);
  useEffect(() => { void runScan(); }, [runScan]);

  const candidates = scan.phase === 'failed' ? [] : scan.candidates ?? [];
  const term = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    const list = term
      ? candidates.filter((item) => [item.name, item.description, item.path, ...item.sources].some((text) => text.toLocaleLowerCase().includes(term)))
      : candidates;
    // 未导入的排前面；同组内保持后端顺序。
    return [...list].sort((a, b) => Number(a.installed) - Number(b.installed));
  }, [candidates, term]);
  const selectable = visible.filter((item) => !item.installed);
  const pickedVisible = selectable.filter((item) => picked.has(item.path)).length;
  const pickable = Math.min(selectable.length, LOCAL_SKILL_BATCH_LIMIT);
  const allState = pickedVisible === 0 ? 'none' : pickedVisible >= pickable ? 'all' : 'some';
  const allRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = allState === 'some'; }, [allState]);

  const toggle = (path: string, on: boolean) => {
    setPicked((current) => {
      if (on && !current.has(path) && current.size >= LOCAL_SKILL_BATCH_LIMIT) return current;
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };
  const toggleAll = (on: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      for (const item of selectable) {
        if (!on) next.delete(item.path);
        else if (next.size < LOCAL_SKILL_BATCH_LIMIT) next.add(item.path);
      }
      return next;
    });
  };

  const begin = (kind: 'batch' | 'folder') => {
    setImporting(kind);
    setBusy(true);
    setOutcome(null);
  };
  const finish = () => {
    if (!alive.current) return;
    setImporting('');
    setBusy(false);
  };

  const importPicked = async () => {
    const paths = candidates.filter((item) => !item.installed && picked.has(item.path)).map((item) => item.path);
    if (!paths.length || busy) return;
    begin('batch');
    let result: LocalSkillBatchImportResult;
    try {
      result = await api.importLocalSkills(paths, { mode });
    } catch (cause) {
      result = { ok: false, imported: 0, failed: [], reason: reasonOf(cause, '导入没有完成') };
    }
    if (!alive.current) return;
    if (result.state) onState(result.state);
    const failed = new Map(result.failed.map((item) => [item.path, item.reason]));
    if (result.imported > 0) onImported();
    if (!result.ok && result.imported === 0 && failed.size === 0) {
      setOutcome({ tone: 'danger', text: result.reason || '导入没有完成，请重试。' });
      finish();
      return;
    }
    // 成功的条目就地标成已导入；失败的保留勾选，便于直接重试。
    const done = new Set(paths.filter((path) => !failed.has(path)));
    setScan((current) => current.phase === 'failed' ? current : {
      ...current,
      candidates: (current.candidates ?? []).map((item) => done.has(item.path) ? { ...item, installed: true } : item),
    });
    setPicked(new Set(paths.filter((path) => failed.has(path))));
    setFailures(failed);
    if (failed.size === 0) setOutcome({ tone: 'ok', text: `已导入 ${result.imported} 个技能。` });
    else if (result.imported > 0) setOutcome({ tone: 'warn', text: `已导入 ${result.imported} 个，${failed.size} 个未能导入，原因见条目。` });
    else setOutcome({ tone: 'danger', text: `${failed.size} 个技能未能导入，原因见条目。` });
    finish();
  };

  const importFolder = async () => {
    if (busy) return;
    begin('folder');
    let result: SkillActionResult;
    try {
      result = await api.importLocalSkill({ mode });
    } catch (cause) {
      result = { ok: false, reason: reasonOf(cause, '导入没有完成') };
    }
    if (!alive.current) return;
    if (result.state) onState(result.state);
    if (result.ok) {
      onImported();
      setOutcome({ tone: 'ok', text: '已从所选文件夹导入技能。' });
      finish();
      void runScan();
      return;
    }
    if (!result.cancelled) setOutcome({ tone: 'danger', text: result.reason || '导入没有完成，请重试。' });
    finish();
  };

  const scanning = scan.phase === 'scanning';
  const hasList = scan.phase !== 'failed' && scan.candidates !== null;
  const warnings = scan.phase === 'failed' ? [] : scan.warnings;
  const newCount = candidates.filter((item) => !item.installed).length;
  const pickedCount = candidates.filter((item) => !item.installed && picked.has(item.path)).length;
  const atLimit = pickedCount >= LOCAL_SKILL_BATCH_LIMIT;

  let body;
  if (scan.phase === 'failed') {
    body = (
      <div className="h71-state" role="alert">
        <p>扫描没有完成：{scan.reason}</p>
        <button type="button" className="h37-btn h37-btn-secondary h37-btn-sm" onClick={() => void runScan()}>重新扫描</button>
      </div>
    );
  } else if (!hasList) {
    body = (
      <div className="h71-list h71-list-loading" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="h71-row" key={index}>
            <span className="h37-skeleton h71-sk-check" />
            <span className="h71-row-text"><span className="h37-skeleton h71-sk-name" /><span className="h37-skeleton" /><span className="h37-skeleton h71-sk-path" /></span>
          </div>
        ))}
      </div>
    );
  } else if (candidates.length === 0) {
    body = (
      <div className="h71-state">
        <p>本机的常见 Agent 目录和当前项目里没有找到技能。</p>
        <p className="h71-state-sub">技能文件夹里需要有 SKILL.md。放在别处的可以手动选择文件夹。</p>
      </div>
    );
  } else if (visible.length === 0) {
    body = <div className="h71-state"><p>没有名称、说明或路径包含「{query.trim()}」的技能。</p></div>;
  } else {
    body = (
      <ul className="h71-list" id={listId} aria-label="找到的技能" data-stale={scanning ? 'true' : 'false'}>
        {visible.map((item, index) => {
          const reason = failures.get(item.path);
          const checked = !item.installed && picked.has(item.path);
          return (
            <li key={item.path}>
              <label className="h71-row" data-installed={item.installed ? 'true' : 'false'} data-checked={checked ? 'true' : 'false'}>
                <input
                  type="checkbox"
                  className="h71-check"
                  checked={checked}
                  disabled={item.installed || busy || (atLimit && !checked)}
                  onChange={(event) => toggle(item.path, event.target.checked)}
                  aria-describedby={reason ? `${listId}-err-${index}` : undefined}
                />
                <span className="h71-row-text">
                  <span className="h71-row-head">
                    <span className="h71-name">{item.name}</span>
                    {item.installed ? <span className="h37-badge" data-tone="ok">已导入</span> : null}
                    {item.sources.length ? <span className="h71-sources">{item.sources.join(' · ')}</span> : null}
                  </span>
                  {item.description ? <span className="h71-desc">{item.description}</span> : null}
                  <span className="h71-path" title={item.path}>{shortPath(item.path)}</span>
                  {reason ? <span className="h71-row-error" id={`${listId}-err-${index}`}>{reason}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <div className="h71-head">
        <div className="h71-head-text">
          <DialogTitle>导入本地技能</DialogTitle>
          <DialogDescription>
            扫描本机常见 Agent 的技能目录和当前项目，勾选后才会{remote ? '导入到这个 Bot' : '导入'}。
          </DialogDescription>
        </div>
        <button
          type="button"
          className="h37-btn h37-btn-ghost h37-btn-icon h71-icon-btn"
          aria-label={scanning ? '正在扫描' : '重新扫描'}
          title="重新扫描"
          disabled={scanning || busy}
          onClick={() => void runScan()}
        >
          <RefreshCw aria-hidden="true" data-spin={scanning ? 'true' : 'false'} />
        </button>
        <DialogClose type="button" className="h37-btn h37-btn-ghost h37-btn-icon h71-icon-btn" aria-label="关闭" disabled={busy}>
          <X aria-hidden="true" />
        </DialogClose>
      </div>

      <p className="h71-import-hint">
        {remote ? '文件会传输到这个 Bot，不会链接本机目录；每个技能限单文件 2 MiB、总计 4 MiB、256 个文件。'
          : '软链接实时引用原目录，不重复占用磁盘空间；原目录改动会同步，移动或删除后会失效。'}
      </p>

      <div className="h71-tools">
        <label className="h71-search h37-input">
          <Search aria-hidden="true" />
          <input
            className="h37-input-bare"
            type="search"
            value={query}
            placeholder="按名称、说明或路径筛选"
            aria-label="筛选技能"
            aria-controls={listId}
            disabled={!hasList || candidates.length === 0}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {hasList && selectable.length > 0 ? (
          <label className="h71-all">
            <input
              ref={allRef}
              type="checkbox"
              className="h71-check"
              checked={allState === 'all'}
              disabled={busy}
              onChange={(event) => toggleAll(event.target.checked)}
            />
            <span>{term ? '全选结果' : '全选'}</span>
          </label>
        ) : null}
      </div>

      <div className="h71-body">
        {body}
        {warnings.length ? (
          <details className="h71-warnings">
            <summary><AlertTriangle aria-hidden="true" />{warnings.length} 个位置没能读取</summary>
            <ul>{warnings.map((text) => <li key={text}>{text}</li>)}</ul>
          </details>
        ) : null}
      </div>

      <div className="h71-foot">
        <p className="h71-status" role="status" aria-live="polite" data-tone={outcome?.tone}>
          {importing === 'batch' ? `正在导入 ${pickedCount} 个技能…`
            : importing === 'folder' ? '请在系统窗口里选择技能文件夹…'
              : outcome ? outcome.text
                : atLimit && newCount > LOCAL_SKILL_BATCH_LIMIT ? `一次最多导入 ${LOCAL_SKILL_BATCH_LIMIT} 个，导入后可继续选择其余技能。`
                : scanning ? (hasList ? '正在重新扫描…' : '正在扫描…')
                  : hasList && candidates.length ? (newCount ? `找到 ${candidates.length} 个，${newCount} 个未导入` : `找到 ${candidates.length} 个，都已导入`)
                    : ''}
        </p>
        <div className="h71-actions">
          <button type="button" className="h37-btn h37-btn-ghost" disabled={busy} onClick={() => void importFolder()}>
            <FolderOpen aria-hidden="true" />手动选择文件夹
          </button>
          {newCount > 0 || importing === 'batch' ? (
            <button type="button" className="h37-btn h37-btn-primary" disabled={busy || pickedCount === 0} onClick={() => void importPicked()}>
              {importing === 'batch' ? <span className="h37-spinner" aria-hidden="true" /> : null}
              {importing === 'batch' ? '正在导入…' : pickedCount ? `导入 ${pickedCount} 个` : '导入所选'}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
