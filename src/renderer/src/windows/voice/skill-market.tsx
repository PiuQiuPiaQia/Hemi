import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ChevronRight, Code, ExternalLink, FileText, FolderOpen,
  ListChecks, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Star, Trash2,
} from 'lucide-react';

import type {
  InstalledSkill, SkillMarketItem, SkillMarketState, SkillsmpPreview, SkillsmpSkill, SkillsmpUpdateResponse,
} from '@/shared/types';
import type { HemiVoiceBridge } from '@shared/protocol';
import './skill-market.css';

export type SkillMarketApi = Pick<HemiVoiceBridge, 'getSkillState' | 'refreshSkillCatalog' | 'importLocalSkill' | 'installMarketSkill' | 'setSkillEnabled' | 'removeSkill' | 'readSkill' | 'revealSkill' | 'searchSkillsMp' | 'previewSkillsMp' | 'installSkillsMp' | 'checkSkillsMpUpdate'>;

type Tab = 'discover' | 'builtin' | 'installed';
type Selected =
  | { kind: 'mp'; skill: SkillsmpSkill }
  | { kind: 'builtin'; id: string }
  | { kind: 'installed'; id: string }
  | null;

/** 检查更新反馈：checking 期间只有进行时标记，完成后带主进程响应。 */
type UpdateCheckState = ({ checking: true } | ({ checking: false } & SkillsmpUpdateResponse)) | null;

const ORIGIN_LABELS: Record<InstalledSkill['origin'], string> = {
  market: 'Hemi 内置目录',
  local: '本地导入',
  skillsmp: 'SkillsMP 市场',
};

/** 037：返回钮标注「回到哪一页」（分段控件的完整名称）。 */
const TAB_LABELS: Record<Tab, string> = {
  discover: '技能市场',
  builtin: '内置技能',
  installed: '已安装',
};

/** 037：顶栏分段控件与技能页之间的接线点——voice-screen 在技能页顶栏标题区放这个空槽，
 *  技能页把「市场 / 内置 / 已安装」与导入按钮 portal 进去；找不到槽时退回页内渲染。 */
export const SKILLS_TOPBAR_SLOT_ID = 'h37-skills-topbar';

/** 元信息行的语言标签：SkillsMP 给的是 ISO 码，常见的换成中文。 */
const LANG_LABELS: Record<string, string> = { zh: '中文', en: '英文', ja: '日文', ko: '韩文' };

const SUGGESTIONS = ['pdf', 'excel', '网页抓取', '代码审查', '会议纪要', 'git'];

/** 市场开门面的随机词池：每次会话随机挑一个拉一批热门技能（034 v5.1，2026-10-09 用户裁决：
 *  默认页不该是上次搜索的陈旧缓存）。 */
const RECOMMEND_WORDS = ['pdf', 'excel', 'ppt', '爬虫', '网页抓取', '代码审查', '会议纪要', 'git', '数据分析', '写作', '表格', '搜索'];

const EMPTY_SKILL: SkillsmpSkill = {
  id: '', name: '', author: '', description: '', contentLanguage: '',
  githubUrl: null, skillUrl: null, stars: null, updatedAt: null,
};

function fmtStars(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '';
  return value >= 10000 ? `${(value / 10000).toFixed(1)} 万星` : `${value.toLocaleString('zh-CN')} 星`;
}

function fmtTime(value: number | null) {
  if (!value || !Number.isFinite(value)) return '';
  return new Date(value > 1e12 ? value : value * 1000).toLocaleDateString('zh-CN');
}

/** 缓存/刷新时间只到分钟——秒级精度是调试口径，页面上只制造噪音。 */
function fmtDateTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

const githubTreeUrl = (github: NonNullable<InstalledSkill['github']>) =>
  `https://github.com/${github.repo}/tree/${github.commit}${github.path ? `/${github.path}` : ''}`;

/** 037 动效：等待不足 300ms 不出骨架，超过才显示。 */
function useDelayedFlag(on: boolean, ms = 300) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on && shown;
}

function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="h34-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="h34-card h34-card-skeleton" key={index}>
          <div className="h34-card-top"><span className="h37-skeleton h34-sk-tile" /><span className="h37-skeleton h34-sk-name" /></div>
          <span className="h37-skeleton" />
          <span className="h37-skeleton h34-sk-short" />
          <span className="h37-skeleton h34-sk-meta" />
        </div>
      ))}
    </div>
  );
}

/** 卡片：图标块＋名称＋状态 badge / 两行说明 / 元信息。整卡是按钮（.h34-list-row 留给脚本）。 */
function SkillCard({ name, description, badge, meta, onOpen, added = false }: {
  name: string;
  /** 已添加 / 已安装的条目图标块着绿色，其余为中性灰。 */
  added?: boolean;
  description: string;
  badge?: ReactNode;
  meta: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="h34-list-row h34-card" onClick={onOpen}>
      <span className="h34-card-top">
        <span className="h37-tile" data-tone={added ? 'g' : undefined}><FileText aria-hidden="true" /></span>
        <strong>{name}</strong>
        {badge}
        <span className="h34-card-go" aria-hidden="true"><ChevronRight /></span>
      </span>
      <span className="h34-card-desc">{description}</span>
      <span className="h34-card-meta">{meta}</span>
    </button>
  );
}

/** 详情页头：48px 图标块 + 来源标签 + 名称（+ 状态 badge）；下面是说明、元信息、外链与操作。
 *  宽屏正文对齐名称列，≤600 正文改为整行（窄屏不再挤在图标右侧的窄列里）。 */
function DetailHero({ tag, title, badge, description, links, meta, actions, cta }: {
  tag: ReactNode;
  title: string;
  /** 名称右侧的状态 badge（已安装详情显示启用状态）。 */
  badge?: ReactNode;
  description: string;
  links?: ReactNode;
  /** 元信息行（作者 · 星标 · 语言 · 收录），各项之间用中点分隔。 */
  meta?: ReactNode;
  /** 头部下方的一行操作按钮（已安装详情）。 */
  actions?: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <header className="h34-hero">
      <span className="h37-tile h34-hero-tile" data-tone="g"><FileText aria-hidden="true" /></span>
      <div className="h34-hero-head">
        <div className="h34-detail-tag">{tag}</div>
        <div className="h34-hero-title"><h2>{title}</h2>{badge}</div>
      </div>
      <div className="h34-hero-body">
        <p>{description}</p>
        {meta ? <div className="h34-hero-meta">{meta}</div> : null}
        {links ? <div className="h34-links">{links}</div> : null}
        {actions ? <div className="h34-detail-actions">{actions}</div> : null}
      </div>
      {cta ? <div className="h34-hero-cta">{cta}</div> : null}
    </header>
  );
}

function KvSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="h37-section">
      <div className="h37-section-head"><h3>{title}</h3></div>
      <dl className="h37-group h34-kv">{children}</dl>
    </section>
  );
}

/** 文件清单先显示前 FILE_PREVIEW 个，其余收在「展开」行里；不再用卡内滚动条（嵌套滚动难核对）。 */
const FILE_PREVIEW = 8;

function FileSection({ title, count, files }: {
  title: string;
  count?: string;
  files: Array<{ path: string; size?: string }>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILE_PREVIEW);
  const hidden = files.length - shown.length;
  return (
    <section className="h37-section">
      <div className="h37-section-head"><h3>{title}</h3>{count ? <span className="h37-count">{count}</span> : null}</div>
      <div className="h37-group h34-file-list">
        {shown.map((file) => {
          const cut = file.path.lastIndexOf('/') + 1;
          return (
            <div className="h37-row h34-file-row" key={file.path} title={file.path}>
              <FileText aria-hidden="true" />
              <span className="h34-mono">{cut ? <i>{file.path.slice(0, cut)}</i> : null}{file.path.slice(cut)}</span>
              {file.size ? <em>{file.size}</em> : null}
            </div>
          );
        })}
        {hidden > 0 || (all && files.length > FILE_PREVIEW) ? (
          <button type="button" className="h37-row h34-file-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
            <ChevronRight aria-hidden="true" />
            {all ? '收起' : `展开其余 ${hidden} 个文件`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** 原文框：超过 SOURCE_CLAMP 行先显示开头一段，底部渐隐 + 「展开全文」；短文直接全显示。 */
const SOURCE_CLAMP = 16;

function SourceText({ text }: { text: string }) {
  const long = text.split('\n').length > SOURCE_CLAMP || text.length > 1600;
  const [open, setOpen] = useState(false);
  return (
    <div className="h37-group h34-source-box" data-clamped={long && !open ? 'true' : 'false'}>
      <pre>{text}</pre>
      {long ? (
        <button type="button" className="h34-source-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? '收起原文' : '展开全文'}
        </button>
      ) : null}
    </div>
  );
}

function SourceSection({ title, text, hint = '' }: { title: string; text: string; hint?: string }) {
  return (
    <section className="h37-section h34-source">
      <div className="h37-section-head"><h3>{title}</h3>{hint ? <span className="h37-count">{hint}</span> : null}</div>
      <SourceText text={text} />
    </section>
  );
}

/** 已安装 / 内置详情的原文：折叠区块，展开时才读取（替代原来的「查看原文」按钮）。 */
function SourceFold({ text, loading, onOpen }: { text: string; loading: boolean; onOpen: () => void }) {
  return (
    <details
      className="h37-section h34-source h34-fold"
      onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !text) onOpen(); }}
    >
      <summary><span className="h34-fold-title">SKILL.md 原文</span>{text ? <span className="h37-count">{`${text.length.toLocaleString('zh-CN')} 字`}</span> : null}<ChevronRight aria-hidden="true" /></summary>
      {text ? <SourceText text={text} /> : (
        <div className="h37-group h34-source-empty" role="status">
          {loading ? <><span className="h37-spinner" aria-hidden="true" />正在读取原文…</> : '原文暂未读到。收起后再展开可重试。'}
        </div>
      )}
    </details>
  );
}

type BarMode = 'idle' | 'reading' | 'confirm' | 'saving' | 'failed';

/** 吸底安装条：左侧状态（标题 + 一行说明），右侧动作。
 *  idle → 安装（先读取来源）→ confirm（核对后确认）→ saving；失败停在 failed 可重试。 */
function InstallBar({ mode, elapsed, installed, installedVersion, reason, failedStage, onInstall, onConfirm, onCancel, onManage }: {
  mode: BarMode;
  elapsed: number;
  installed: boolean;
  /** 已安装版本的显示文本（提交短号），只在 installed 时用。 */
  installedVersion: string;
  /** 读取失败的具体原因。 */
  reason: string;
  failedStage: 'read' | 'save';
  onInstall: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onManage: () => void;
}) {
  const busy = mode === 'reading' || mode === 'saving';
  const icon = busy ? <span className="h37-spinner" />
    : mode === 'failed' ? <ShieldAlert />
      : mode === 'confirm' ? <ListChecks />
        : <ShieldCheck />;
  const title = {
    idle: installed ? `已安装提交 ${installedVersion}` : '安装前会先给你核对',
    reading: `正在读取来源文件${elapsed >= 1 ? `（已等 ${elapsed} 秒）` : ''}`,
    confirm: '核对无误后再安装',
    saving: '正在核对并保存',
    failed: failedStage === 'read' ? '来源文件没读到' : '安装没有完成',
  }[mode];
  const sub = {
    idle: installed ? '更新同样会先列出新版文件，确认后才替换。' : '先读取来源并列出全部文件，确认后才保存。',
    reading: '',
    confirm: '安装后自动启用',
    saving: '',
    failed: failedStage === 'read' ? reason : installed ? '已安装的版本不受影响' : '',
  }[mode];
  return (
    <div className="h34-confirm-bar" data-mode={mode} data-busy={busy ? 'true' : 'false'}>
      <span className="h34-bar-icon" aria-hidden="true">{icon}</span>
      <span className="h34-bar-status" role="status">
        <strong>{title}</strong>
        {sub ? <small>{sub}</small> : null}
      </span>
      <span className="h34-cta-row">
        {mode === 'idle' && installed ? (
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-lg" onClick={onManage}>管理已安装版本</button>
        ) : null}
        {mode === 'confirm' || (mode === 'failed' && failedStage === 'save') ? (
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-lg" onClick={onCancel}>取消</button>
        ) : null}
        {mode === 'confirm' || (mode === 'failed' && failedStage === 'save') || mode === 'saving' ? (
          <button type="button" className="h37-btn h37-btn-primary h37-btn-lg" disabled={mode === 'saving'} onClick={onConfirm}>
            {mode === 'saving' ? '正在安装…' : mode === 'failed' ? '重试安装' : installed ? '确认更新' : '确认安装'}
          </button>
        ) : (
          <button type="button" className="h37-btn h37-btn-primary h37-btn-lg" disabled={mode === 'reading'} onClick={onInstall}>
            {mode === 'reading' ? '正在读取…' : mode === 'failed' ? '重新读取' : installed ? '更新到最新' : '安装'}
          </button>
        )}
      </span>
    </div>
  );
}

export function SkillMarket({ onBack, pendingApproval = false, demo = '', api = window.hemiVoice, remote = false, inline = false, initialTab = 'discover' }: {
  api?: SkillMarketApi;
  remote?: boolean;
  /** 嵌入非整页容器（如设置页）时用 section 根，避免 main 套 main；行为仍按本地/远端。 */
  inline?: boolean;
  initialTab?: Tab;
  onBack: () => void;
  pendingApproval?: boolean;
  /** fixtures 专用：预置技能页内部状态（mp-results / mp-preview / installed），产品代码不传。 */
  demo?: string;
}) {
  const [state, setState] = useState<SkillMarketState | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'stars' | 'recent'>('stars');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResult, setSearchResult] = useState<SkillMarketState['mpSearch']>(null);
  const [liveSearch, setLiveSearch] = useState(false);
  /** 当前结果是否为开门面自动拉取的推荐（用户一搜索即清空；缓存预填也不是推荐）。 */
  const [autoWord, setAutoWord] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>(null);
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  const lastQuery = useRef('');
  const scrollRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setTopbarSlot(document.getElementById(SKILLS_TOPBAR_SLOT_ID));
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await api.getSkillState();
      setState(next);
      setSearchResult((current) => current ?? next.mpSearch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '技能列表读取失败');
    }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const act = useCallback(async (label: string, action: () => Promise<{
    ok: boolean; cancelled?: boolean; reason?: string; state?: SkillMarketState | null;
  }>) => {
    setBusy(label);
    setError('');
    try {
      const result = await action();
      if (result.state) setState(result.state);
      if (!result.ok && !result.cancelled) setError(result.reason || '操作未完成');
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成');
      return { ok: false };
    } finally {
      setBusy('');
    }
  }, []);

  const runSearch = useCallback(async (term: string, order: 'stars' | 'recent') => {
    const keyword = term.trim();
    if (!keyword) {
      setSearchError('请输入搜索关键词，例如 pdf 或 会议纪要。');
      return;
    }
    setSearchBusy(true);
    setSearchError('');
    setAutoWord(null);
    try {
      const result = await api.searchSkillsMp({ query: keyword, sortBy: order });
      if (result.ok) {
        lastQuery.current = keyword;
        setLiveSearch(true);
        setSearchResult({
          schema: 1, query: result.query ?? keyword, sortBy: result.sortBy ?? order,
          skills: result.skills ?? [], checkedAt: result.checkedAt ?? Date.now(),
          pagination: result.pagination ?? { page: 1, totalPages: 1, total: (result.skills ?? []).length, hasNext: false },
        });
      } else {
        setSearchError(result.reason || '搜索未完成');
        if (result.cached) {
          setSearchResult(result.cached);
          setLiveSearch(false);
        }
      }
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : '搜索未完成');
    } finally {
      setSearchBusy(false);
    }
  }, [api]);

  // 034 v5.1：开门面。每个会话首次打开市场，随机挑词拉一批热门技能——默认页不再
  // 是上次搜索的陈旧缓存。失败静默回落（有缓存显缓存，无缓存显推荐词引导），
  // 不用错误条打脸一个还没开始搜索的用户。
  const recommendTried = useRef(false);
  const runRecommend = useCallback(async (word: string) => {
    setSearchBusy(true);
    setSearchError('');
    try {
      const result = await api.searchSkillsMp({ query: word, sortBy: 'stars' });
      if (result.ok) {
        lastQuery.current = word;
        setLiveSearch(true);
        setAutoWord(word);
        setSearchResult({
          schema: 1, query: result.query ?? word, sortBy: result.sortBy ?? 'stars',
          skills: result.skills ?? [], checkedAt: result.checkedAt ?? Date.now(),
          pagination: result.pagination ?? { page: 1, totalPages: 1, total: (result.skills ?? []).length, hasNext: false },
        });
      }
    } catch {
      /* 静默：门面拉不到不算用户的错 */
    } finally {
      setSearchBusy(false);
    }
  }, [api]);
  useEffect(() => {
    if (demo || tab !== 'discover' || recommendTried.current) return;
    recommendTried.current = true;
    void runRecommend(RECOMMEND_WORDS[Math.floor(Math.random() * RECOMMEND_WORDS.length)]);
  }, [demo, tab, runRecommend]);

  // 034 v5（2026-10-09 用户裁决）：详情页用市场元数据秒开，点「安装」后才拉来源。
  // 2026-10 详情页重排：读取来源（钉固定提交）→ 列出核对材料（固定提交 / 文件清单 /
  // 总量 / SKILL.md 原文）→ 用户点「确认安装」才核对并保存。读取完不再自动落盘。
  const [panel, setPanel] = useState<{ state: 'idle' | 'loading' | 'shown' | 'error'; preview?: SkillsmpPreview; reason?: string }>({ state: 'idle' });
  const [installPhase, setInstallPhase] = useState<'' | 'read' | 'save'>('');
  /** 保存阶段失败的原因：留在详情页上就地重试，不再只靠页顶错误条。 */
  const [saveFailure, setSaveFailure] = useState('');
  const previewCache = useRef(new Map<string, SkillsmpPreview>());
  const selectedRef = useRef<Selected>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const stillOn = useCallback((skillId: string) => {
    const current = selectedRef.current;
    return current !== null && current.kind === 'mp' && current.skill.id === skillId;
  }, []);

  /** 拉取预览（固定提交快照）作为核对材料；迟到的结果不落到已换看的条目上。
   *  失败原因记在 panel 上，由安装流程第一步与吸底条就地显示。 */
  const loadPanel = useCallback(async (skill: SkillsmpSkill) => {
    const cached = previewCache.current.get(skill.id);
    if (cached) {
      setPanel({ state: 'shown', preview: cached });
      return cached;
    }
    setPanel({ state: 'loading' });
    try {
      const result = await api.previewSkillsMp(skill.id);
      if (!stillOn(skill.id)) return null;
      if (!result.ok || !result.preview) {
        setPanel({ state: 'error', reason: result.reason || '来源文件读取失败' });
        return null;
      }
      previewCache.current.set(skill.id, result.preview);
      setPanel({ state: 'shown', preview: result.preview });
      return result.preview;
    } catch (cause) {
      if (stillOn(skill.id)) setPanel({ state: 'error', reason: cause instanceof Error ? cause.message : '来源文件读取失败' });
      return null;
    }
  }, [api, stillOn]);

  /** 安装第一步：读取来源，读完停在核对态。 */
  const runInstall = useCallback(async (skill: SkillsmpSkill) => {
    setError('');
    setSaveFailure('');
    setInstallPhase('read');
    try {
      await loadPanel(skill);
    } finally {
      setInstallPhase('');
    }
  }, [loadPanel]);

  /** 安装第二步：用户核对后确认，按已展示的固定提交与摘要保存。 */
  const confirmInstall = useCallback(async (preview: SkillsmpPreview) => {
    setError('');
    setSaveFailure('');
    setInstallPhase('save');
    try {
      const result = await api.installSkillsMp({
        skillsmpId: preview.skillsmpId,
        commit: preview.commit,
        bundleSha256: preview.bundleSha256,
        githubUrl: preview.githubUrl,
        author: preview.author,
        skillUrl: preview.skillUrl,
      });
      if (result.ok) {
        if (result.state) setState(result.state);
        setSelected({ kind: 'installed', id: result.skill?.id ?? `skillsmp:${preview.skillsmpId}` });
        setTab('installed');
        void reload();
      } else {
        setSaveFailure(result.reason || '安装未完成');
      }
    } catch (cause) {
      setSaveFailure(cause instanceof Error ? cause.message : '安装未完成');
    } finally {
      setInstallPhase('');
    }
  }, [api, reload]);

  const runUpdateCheck = useCallback(async (installed: InstalledSkill) => {
    setUpdateCheck({ checking: true });
    setError('');
    try {
      const result = await api.checkSkillsMpUpdate(installed.id);
      setUpdateCheck({ checking: false, ...result });
      if (!result.ok) setError(result.reason || '检查更新失败');
    } catch (cause) {
      setUpdateCheck(null);
      setError(cause instanceof Error ? cause.message : '检查更新失败');
    }
  }, [api]);

  // 安装阶段一的等待反馈：大技能或弱网可能要等十几秒，只给静态文案会被当成卡死。
  const [installElapsed, setInstallElapsed] = useState(0);
  useEffect(() => {
    if (installPhase === '') return;
    const started = Date.now();
    setInstallElapsed(0);
    const timer = window.setInterval(() => setInstallElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [installPhase]);

  // fixtures 预置：见 demo prop 注释。
  useEffect(() => {
    if (!demo) return;
    if (demo === 'mp-results') {
      setQuery('pdf');
      void runSearch('pdf', 'stars');
    }
    if (demo === 'mp-preview') {
      // 详情页核对态（点「安装」后读完来源、等待用户确认）。
      // 选未安装的条目（fixtures 的 nano-pdf 已预装，选中它吸底条会是更新态）。
      setQuery('pdf');
      void runSearch('pdf', 'stars').then(() => {
        void api.searchSkillsMp({ query: 'pdf', sortBy: 'stars' }).then((result) => {
          const skills = result.ok ? result.skills ?? [] : [];
          const skill = skills.find((entry) => entry.id === 'demo-excel-helper-skill-md') ?? skills[0];
          if (skill) {
            select({ kind: 'mp', skill });
            // 走真实的「安装」第一步：读取中带已等秒数，读完停在核对态（不保存）。
            void runInstall(skill);
          }
        }).catch(() => {});
      });
    }
    if (demo === 'mp-detail') {
      // idle 详情页：只选中不拉来源（验「元数据秒开 + 安装流程说明」的排版）。
      // 优先选未安装的条目——演示场景要呈现「安装」主按钮而非「更新到最新」。
      void (async () => {
        try {
          const [result, skillState] = await Promise.all([
            api.searchSkillsMp({ query: 'pdf', sortBy: 'stars' }),
            api.getSkillState(),
          ]);
          const list = result.ok ? result.skills ?? [] : [];
          const installedIds = new Set((skillState?.installed ?? []).map((item) => item.id));
          const skill = list.find((entry) => !installedIds.has(`skillsmp:${entry.id}`)) ?? list[0] ?? null;
          if (skill) select({ kind: 'mp', skill });
        } catch { /* 静默：演示数据不可用不算错误 */ }
      })();
    }
    if (demo === 'builtin') setTab('builtin');
  }, [api, demo, runSearch, runInstall]);
  useEffect(() => {
    if (demo !== 'installed' || !state || selected) return;
    const item = state.installed.find((entry) => entry.origin === 'skillsmp') ?? state.installed[0];
    if (item) {
      setTab('installed');
      setSelected({ kind: 'installed', id: item.id });
    }
  }, [demo, state, selected]);

  const openSource = async (id: string) => {
    setBusy('读取原文');
    try {
      const result = await api.readSkill(id);
      if (!result.ok) setError(result.reason || '原文读取失败');
      else setSourceText(result.text ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '原文读取失败');
    } finally {
      setBusy('');
    }
  };

  const openExternal = (url: string | null | undefined) => {
    if (url) void window.hemiVoice.openExternal(url);
  };

  const installed = state?.installed ?? [];
  const catalog = state?.catalog ?? [];
  const term = query.trim().toLocaleLowerCase();
  const matches = (item: { name: string; title: string; description: string }) =>
    !term || [item.name, item.title, item.description].some((text) => text.toLocaleLowerCase().includes(term));
  const filteredCatalog = useMemo(() => catalog.filter(matches), [catalog, term]);
  const filteredInstalled = useMemo(() => installed.filter(matches), [installed, term]);

  const selectedInstalled = selected?.kind === 'installed'
    ? installed.find((item) => item.id === selected.id) ?? null
    : selected?.kind === 'mp'
      ? installed.find((item) => item.id === `skillsmp:${selected.skill.id}`) ?? null
      : null;
  const selectedBuiltin: SkillMarketItem | null = selected?.kind === 'builtin'
    ? catalog.find((item) => item.id === selected.id) ?? null
    : selectedInstalled?.origin === 'market'
      ? catalog.find((item) => item.id === selectedInstalled.id.slice('market:'.length)) ?? null
      : null;
  const builtinInstalled = selectedBuiltin ? installed.find((item) => item.id === `market:${selectedBuiltin.id}`) ?? null : null;
  const builtinUpdateAvailable = Boolean(selectedInstalled && selectedBuiltin && selectedInstalled.sha256 !== selectedBuiltin.sha256);

  // 037：列表与详情不再并排——点卡片下钻到详情页（280ms 自右 24px），返回钮回列表。
  const detailOpen = selected?.kind === 'mp'
    || (selected?.kind === 'builtin' && Boolean(selectedBuiltin))
    || (selected?.kind === 'installed' && Boolean(selectedInstalled));
  const detailKey = !selected ? ''
    : selected.kind === 'mp' ? `mp:${selected.skill.id}`
      : `${selected.kind}:${selected.id}`;

  // 下钻 / 返回时回到页顶（同一滚动容器承载列表与详情）。
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [detailKey]);

  const clearSelection = () => { selectedRef.current = null; setSelected(null); setSourceText(''); setUpdateCheck(null); setPanel({ state: 'idle' }); setSaveFailure(''); };
  const switchTab = (next: Tab) => { setTab(next); clearSelection(); };
  // selectedRef 同步更新：select 后同刻发起的 loadPanel/runInstall（fixtures demo 即如此）
  // 也要能通过 stillOn 守卫，等 effect 异步刷 ref 会误判成「已换看」。
  const select = (next: NonNullable<Selected>) => {
    selectedRef.current = next;
    setSelected(next);
    setSourceText('');
    setUpdateCheck(null);
    setPanel({ state: 'idle' });
    setSaveFailure('');
  };

  const showSkeleton = useDelayedFlag(searchBusy || !state);
  // 按钮内的进行中标记同样延迟 300ms，快操作不闪 spinner。
  const busySpinner = useDelayedFlag(Boolean(busy));
  const updateSpinner = useDelayedFlag(updateCheck?.checking === true);

  const topbar = (
    <>
      <div className="h34-tabs h37-seg" role="tablist" aria-label="技能分类">
        <button type="button" role="tab" aria-selected={tab === 'discover'} onClick={() => switchTab('discover')}>市场</button>
        <button type="button" role="tab" aria-selected={tab === 'builtin'} onClick={() => switchTab('builtin')}>内置</button>
        <button type="button" role="tab" aria-selected={tab === 'installed'} onClick={() => switchTab('installed')}>已安装<span className="h37-count">{installed.length}</span></button>
      </div>
      <button
        type="button"
        className="h37-btn h37-btn-ghost h34-import"
        title="导入本地技能"
        aria-label="导入本地技能"
        disabled={Boolean(busy)}
        onClick={() => void act('导入本地技能', () => api.importLocalSkill())}
      >
        <Plus aria-hidden="true" /><span className="h34-import-label">导入本地技能</span>
      </button>
    </>
  );

  const localSearch = (placeholder: string, label: string) => (
    <div className="h34-toolbar">
      <label className="h34-search h37-input">
        <Search aria-hidden="true" />
        <input className="h37-input-bare" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} aria-label={label} />
      </label>
    </div>
  );

  const actionButtons = (item: InstalledSkill, extra?: ReactNode) => (
    <>
      {extra}
      <button type="button" className="h37-btn h37-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('切换启用状态', () => api.setSkillEnabled(item.id, !item.enabled))}>{item.enabled ? '停用技能' : '启用技能'}</button>
      {!remote ? <button type="button" className="h37-btn h37-btn-ghost" disabled={Boolean(busy)} onClick={() => void act('打开目录', () => api.revealSkill(item.id))}><FolderOpen aria-hidden="true" /> 打开目录</button> : null}
      <button type="button" className="h37-btn h37-btn-ghost h37-btn-danger" disabled={Boolean(busy)} onClick={() => setConfirmRemove(item.id)}><Trash2 aria-hidden="true" /> 卸载</button>
    </>
  );
  const enabledBadge = (item: InstalledSkill) => (
    <span className="h37-badge" data-tone={item.enabled ? 'ok' : undefined}>{item.enabled ? '已启用' : '已停用'}</span>
  );
  const sourceFold = (id: string) => (
    <SourceFold text={sourceText} loading={busy === '读取原文'} onOpen={() => void openSource(id)} />
  );

  const updateNote = (item: InstalledSkill) => {
    if (!updateCheck || updateCheck.checking === true || !item.github) return null;
    const github = item.github;
    const tone = updateCheck.status === 'up-to-date' ? 'g' : updateCheck.status === 'update-available' ? undefined : 'warn';
    return (
      <div className="h37-note h34-update-box" data-tone={tone}>
        {updateCheck.status === 'up-to-date' ? <ShieldCheck aria-hidden="true" /> : updateCheck.status === 'update-available' ? <RefreshCw aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
        <p role="status">
          <span>
            {updateCheck.status === 'up-to-date' ? `已是最新，固定提交 ${updateCheck.commit?.slice(0, 12) ?? item.version}。` : null}
            {updateCheck.status === 'update-available' ? `来源有新提交 ${updateCheck.commit?.slice(0, 12) ?? ''}。更新前会先列出新版文件。` : null}
            {updateCheck.status === 'source-changed' ? `${updateCheck.reason ?? '来源已变化'}。已安装版本仍按原提交可用。` : null}
            {updateCheck.status === 'unavailable' ? `${updateCheck.reason ?? '暂无法核对来源'}。已安装版本不受影响。` : null}
          </span>
          {updateCheck.status === 'update-available' && updateCheck.githubUrl ? (
            <button type="button" className="h37-link h34-link" onClick={() => { select({ kind: 'mp', skill: { ...EMPTY_SKILL, id: github.entryId, name: item.name, author: item.author, githubUrl: updateCheck.githubUrl!, skillUrl: github.url || null } }); }}>查看新版并更新</button>
          ) : null}
          {updateCheck.status === 'source-changed' ? (
            <button type="button" className="h37-link h34-link" onClick={() => { select({ kind: 'mp', skill: { ...EMPTY_SKILL, id: github.entryId, name: item.name, author: item.author, githubUrl: github.githubUrl, skillUrl: github.url || null } }); }}>按原来源重新检查</button>
          ) : null}
        </p>
      </div>
    );
  };

  const installedBody = (item: InstalledSkill) => (
    <>
      <DetailHero
        tag={`${ORIGIN_LABELS[item.origin]} · 已安装`}
        title={item.title}
        badge={enabledBadge(item)}
        description={item.description}
        links={item.github ? (
          <>
            {item.github.url ? <button type="button" className="h37-link h34-link" onClick={() => openExternal(item.github!.url)}><ExternalLink aria-hidden="true" /> SkillsMP 页面</button> : null}
            <button type="button" className="h37-link h34-link" onClick={() => openExternal(githubTreeUrl(item.github!))}><Code aria-hidden="true" /> GitHub（固定提交）</button>
          </>
        ) : null}
        actions={actionButtons(item)}
      />
      <section className="h37-section">
        <div className="h37-section-head">
          <h3>来源</h3>
          <span className="h37-count">{ORIGIN_LABELS[item.origin]}</span>
          {item.origin === 'skillsmp' && item.github ? (
            <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm h37-aside" disabled={updateCheck?.checking === true || Boolean(busy)} onClick={() => void runUpdateCheck(item)}>
              {updateSpinner ? <span className="h37-spinner" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />} {updateCheck?.checking === true ? '正在检查…' : '检查更新'}
            </button>
          ) : null}
        </div>
        <dl className="h37-group h34-kv">
          {item.github ? (
            <>
              <div><dt>仓库</dt><dd className="h34-mono">{item.github.repo}{item.github.path ? ` / ${item.github.path}` : ''}</dd></div>
              <div><dt>固定提交</dt><dd className="h34-mono h34-hash">{item.github.commit}</dd></div>
              <div><dt>作者</dt><dd>{item.author}</dd></div>
              <div><dt>条目</dt><dd className="h34-mono">{item.github.entryId}</dd></div>
            </>
          ) : (
            <>
              <div><dt>来源</dt><dd className={item.origin === 'local' ? 'h34-mono' : undefined}>{item.origin === 'local' ? item.sourcePath : 'Hemi 内置目录'}</dd></div>
              <div><dt>版本</dt><dd>{item.version}</dd></div>
              <div><dt>作者</dt><dd>{item.author}</dd></div>
              <div><dt>标识</dt><dd className="h34-mono">{item.name}</dd></div>
            </>
          )}
        </dl>
        {updateNote(item)}
      </section>
      <FileSection title="包含文件" count={`${item.files.length} 个`} files={item.files.map((file) => ({ path: file }))} />
      {sourceFold(item.id)}
      <p className="h34-footnote"><ShieldCheck aria-hidden="true" /><span>技能只是做事的方法说明，实际工具调用仍按权限设置确认。</span></p>
    </>
  );

  const detail = (() => {
    if (selected?.kind === 'mp') {
      // v5：详情页用市场元数据秒开；点「安装」才读来源，读完停在核对态，确认后才保存。
      const skill = selected.skill;
      const preview = panel.state === 'shown' ? panel.preview ?? null : null;
      const barMode: BarMode = installPhase === 'save' ? 'saving'
        : installPhase === 'read' || panel.state === 'loading' ? 'reading'
          : panel.state === 'error' || saveFailure ? 'failed'
            : preview ? 'confirm' : 'idle';
      const langLabel = skill.contentLanguage ? (LANG_LABELS[skill.contentLanguage.toLowerCase()] ?? skill.contentLanguage.toUpperCase()) : '';
      return (
        <>
          <DetailHero
            tag="SkillsMP 市场"
            title={skill.name}
            badge={selectedInstalled ? enabledBadge(selectedInstalled) : undefined}
            description={skill.description || '（SkillsMP 未提供描述，以来源文件为准）'}
            meta={(
              <>
                <span>{skill.author || '作者未知'}</span>
                {skill.stars !== null ? <span><Star aria-hidden="true" />{fmtStars(skill.stars)}</span> : null}
                {langLabel ? <span>{langLabel}</span> : null}
                {skill.updatedAt ? <span>{fmtTime(skill.updatedAt)} 收录</span> : null}
              </>
            )}
            links={(
              <>
                {skill.skillUrl ? <button type="button" className="h37-link h34-link" onClick={() => openExternal(skill.skillUrl)}><ExternalLink aria-hidden="true" /> SkillsMP 页面</button> : null}
                {skill.githubUrl ? <button type="button" className="h37-link h34-link" onClick={() => openExternal(skill.githubUrl)}><Code aria-hidden="true" /> GitHub 仓库</button> : null}
              </>
            )}
            /* 安装主操作在头部（好点）；读取/核对/失败态由吸底条接管，避免双主按钮。 */
            cta={barMode === 'idle' && skill.githubUrl ? (
              selectedInstalled ? (
                <div className="h34-cta-row">
                  <button type="button" className="h37-btn h37-btn-ghost h37-btn-lg" onClick={() => select({ kind: 'installed', id: selectedInstalled.id })}>管理已安装版本</button>
                  <button type="button" className="h37-btn h37-btn-primary h37-btn-lg" onClick={() => void runInstall(skill)}>更新到最新</button>
                </div>
              ) : (
                <button type="button" className="h37-btn h37-btn-primary h37-btn-lg" onClick={() => void runInstall(skill)}>安装</button>
              )
            ) : null}
          />
          {skill.githubUrl ? (
            <>
              {preview ? (
                <>
                  {selectedInstalled ? (
                    <div className="h37-note h34-review-note" data-tone="warn" role="status">
                      <ShieldAlert aria-hidden="true" />
                      <span>已安装{selectedInstalled.github ? `提交 ${selectedInstalled.version}` : ` v${selectedInstalled.version}`}。确认后会用下面列出的文件替换它。</span>
                    </div>
                  ) : null}
                  <section className="h37-section">
                    <div className="h37-section-head"><h3>来源</h3><span className="h37-count">安装将锁定这个提交</span></div>
                    <dl className="h37-group h34-kv">
                      <div><dt>仓库</dt><dd className="h34-mono">{preview.repo}{preview.dirPath ? ` / ${preview.dirPath}` : ''}</dd></div>
                      <div><dt>固定提交</dt><dd className="h34-mono h34-hash">{preview.commit}</dd></div>
                      <div><dt>内容摘要</dt><dd className="h34-mono h34-hash">SHA-256 {preview.bundleSha256}</dd></div>
                      <div><dt>作者</dt><dd>{preview.author || '作者未知'}</dd></div>
                    </dl>
                  </section>
                  <FileSection
                    title="将保存的文件"
                    count={`${preview.files.length} 个 · 共 ${fmtBytes(preview.totalBytes)}`}
                    files={preview.files.map((file) => ({ path: file.path, size: fmtBytes(file.size) }))}
                  />
                  <SourceSection title="SKILL.md 原文" text={preview.skillMd} hint={`${preview.skillMd.length.toLocaleString('zh-CN')} 字`} />
                  {saveFailure ? (
                    <div className="h37-note h34-review-error" data-tone="danger" role="alert">
                      <ShieldAlert aria-hidden="true" />
                      <span>{saveFailure}。</span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {/* 吸底条只在读取/核对/保存/失败态出现；idle 的主操作在头部。 */}
              {barMode !== 'idle' ? (
                <>
                  <div className="h34-bar-spacer" aria-hidden="true" />
                  <InstallBar
                    mode={barMode}
                    elapsed={installElapsed}
                    installed={Boolean(selectedInstalled)}
                    installedVersion={selectedInstalled?.version ?? ''}
                    reason={panel.reason ?? ''}
                    failedStage={saveFailure ? 'save' : 'read'}
                    onInstall={() => void runInstall(skill)}
                    onConfirm={() => { if (preview) void confirmInstall(preview); }}
                    onCancel={() => { setSaveFailure(''); setPanel({ state: 'idle' }); }}
                    onManage={() => selectedInstalled && select({ kind: 'installed', id: selectedInstalled.id })}
                  />
                </>
              ) : null}
            </>
          ) : (
            <div className="h37-note h34-review-note" data-tone="warn" role="status"><ShieldAlert aria-hidden="true" /><span>该条目没有 GitHub 来源，无法添加到 Hemi。</span></div>
          )}
        </>
      );
    }
    if (selected?.kind === 'builtin' && selectedBuiltin) {
      const installedItem = builtinInstalled;
      return (
        <>
          <DetailHero
            tag="Hemi 内置目录"
            title={selectedBuiltin.title}
            badge={installedItem ? enabledBadge(installedItem) : undefined}
            description={selectedBuiltin.description}
            actions={installedItem ? actionButtons(installedItem, builtinUpdateAvailable ? (
              <button type="button" className="h37-btn h37-btn-primary" disabled={Boolean(busy)} onClick={() => void act('更新技能', () => api.installMarketSkill(selectedBuiltin.id))}>更新到 v{selectedBuiltin.version}</button>
            ) : null) : undefined}
            cta={installedItem ? null : (
              <>
                <button type="button" className="h37-btn h37-btn-primary h37-btn-lg" disabled={Boolean(busy)} onClick={() => void act('安装技能', () => api.installMarketSkill(selectedBuiltin.id))}>
                  {busy === '安装技能' && busySpinner ? <span className="h37-spinner" aria-hidden="true" /> : null}
                  {busy === '安装技能' ? '正在安装…' : '安装并启用'}
                </button>
                <small>随 Hemi 发布，可离线安装</small>
              </>
            )}
          />
          <KvSection title="来源">
            <div><dt>来源</dt><dd>Hemi 内置目录</dd></div>
            <div><dt>版本</dt><dd>v{selectedBuiltin.version}</dd></div>
            <div><dt>作者</dt><dd>{selectedBuiltin.author}</dd></div>
            <div><dt>标识</dt><dd className="h34-mono">{selectedBuiltin.name}</dd></div>
            <div><dt>目录发布</dt><dd>{state?.publishedAt ?? '未知'}</dd></div>
          </KvSection>
          <FileSection title="包含文件" count={`${selectedBuiltin.files.length} 个`} files={selectedBuiltin.files.map((file) => ({ path: file }))} />
          {installedItem ? sourceFold(installedItem.id) : null}
          <p className="h34-footnote"><ShieldCheck aria-hidden="true" /><span>安装不会运行脚本，任务使用时仍按权限设置确认。</span></p>
        </>
      );
    }
    if (selected?.kind === 'installed' && selectedInstalled) return installedBody(selectedInstalled);
    return null;
  })();

  const list = tab === 'discover' ? (
    <section className="h34-list" aria-label="SkillsMP 技能市场">
      <form className="h34-search-form h34-toolbar" onSubmit={(event) => { event.preventDefault(); void runSearch(query, sortBy); }}>
        <label className="h34-search h37-input">
          <Search aria-hidden="true" />
          <input className="h37-input-bare" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能，例如 pdf、excel、代码审查" aria-label="搜索 SkillsMP 技能" />
        </label>
        <div className="h34-search-tools h37-seg" role="group" aria-label="排序方式">
          <button type="button" aria-pressed={sortBy === 'stars'} data-on={sortBy === 'stars'} onClick={() => { setSortBy('stars'); if (lastQuery.current) void runSearch(lastQuery.current, 'stars'); }}>星标最多</button>
          <button type="button" aria-pressed={sortBy === 'recent'} data-on={sortBy === 'recent'} onClick={() => { setSortBy('recent'); if (lastQuery.current) void runSearch(lastQuery.current, 'recent'); }}>最近更新</button>
        </div>
        <button type="submit" className="h37-btn h37-btn-secondary h34-search-submit" disabled={searchBusy}>{searchBusy ? '搜索中…' : '搜索'}</button>
      </form>
      {searchError ? <div className="h37-note h34-error" data-tone="danger" role="status"><span>{searchError}{searchResult ? `。以下为上次搜索「${searchResult.query}」的结果（${fmtDateTime(searchResult.checkedAt)}），非实时。` : ''}</span></div> : null}
      {searchBusy ? (
        <>
          <div className="h34-cache-note" role="status">正在搜索 SkillsMP…</div>
          {showSkeleton ? <SkeletonGrid /> : null}
        </>
      ) : searchResult?.skills.length ? (
        <>
          <div className={liveSearch ? 'h34-cache-note h34-cache-live' : 'h34-cache-note'} role="status">
            {liveSearch
              ? (autoWord
                ? `为你拉取的热门技能 · 关键词「${autoWord}」 · ${searchResult.skills.length} 个 · ${fmtDateTime(searchResult.checkedAt)}`
                : `「${searchResult.query}」实时结果 · ${searchResult.skills.length} 个 · ${fmtDateTime(searchResult.checkedAt)}`)
              : `上次搜索「${searchResult.query}」的结果 · ${searchResult.skills.length} 个 · ${fmtDateTime(searchResult.checkedAt)}（缓存，非实时）`}
          </div>
          <div className="h34-list-rows h34-grid">
            {searchResult.skills.map((skill) => {
              const added = installed.some((item) => item.id === `skillsmp:${skill.id}`);
              return (
                <SkillCard
                  key={skill.id}
                  added={added}
                  name={skill.name}
                  description={skill.description || '（SkillsMP 未提供描述）'}
                  badge={added ? <span className="h37-badge" data-tone="ok">已添加</span> : null}
                  meta={(
                    <>
                      {skill.author ? <span>{skill.author}</span> : null}
                      {skill.stars !== null ? <span><Star aria-hidden="true" />{fmtStars(skill.stars)}</span> : null}
                      {skill.contentLanguage ? <span>{skill.contentLanguage.toUpperCase()}</span> : null}
                      {skill.updatedAt ? <span>{fmtTime(skill.updatedAt)}</span> : null}
                    </>
                  )}
                  onOpen={() => select({ kind: 'mp', skill })}
                />
              );
            })}
          </div>
        </>
      ) : searchResult ? <div className="h34-empty">没有找到匹配「{searchResult.query}」的技能。换个关键词试试。</div>
        : searchError ? null
        : (
          <div className="h34-suggest">
            <p>搜索社区开源的 Agent Skill。点开条目看详情，点安装后才从 GitHub 固定提交读取并核对文件。</p>
            <div className="h34-chips" aria-label="推荐搜索词">
              {SUGGESTIONS.map((word) => (
                <button type="button" className="h37-chip" key={word} onClick={() => { setQuery(word); void runSearch(word, sortBy); }}>{word}</button>
              ))}
            </div>
          </div>
        )}
      <p className="h34-footnote"><ShieldCheck aria-hidden="true" /><span>条目来自第三方 GitHub 仓库；安装前按固定提交核对文件并经你确认，实际操作仍按权限设置确认。</span></p>
    </section>
  ) : tab === 'builtin' ? (
    <section className="h34-list" aria-label="Hemi 内置技能目录">
      <div className="h34-toolbar-row">
        {localSearch('搜索名称或用途', '搜索内置技能')}
        <button type="button" className="h37-btn h37-btn-ghost h37-btn-icon" aria-label="刷新内置目录" title="刷新内置目录" disabled={Boolean(busy)} onClick={() => void act('刷新目录', () => api.refreshSkillCatalog())}><RefreshCw aria-hidden="true" /></button>
      </div>
      <div className="h34-cache-note">Hemi 内置技能 · {filteredCatalog.length} 个技能</div>
      {!state && showSkeleton ? <SkeletonGrid count={3} /> : filteredCatalog.length ? (
        <div className="h34-list-rows h34-grid">
          {filteredCatalog.map((item) => {
            const added = installed.find((entry) => entry.id === `market:${item.id}`);
            return (
              <SkillCard
                key={item.id}
                added={Boolean(added)}
                name={item.title}
                description={item.description}
                badge={added ? <span className="h37-badge" data-tone="ok">已安装</span> : null}
                meta={(
                  <>
                    <span>Hemi 内置目录</span>
                    <span>v{item.version}</span>
                    <span>{item.files.length} 个文件</span>
                  </>
                )}
                onOpen={() => select({ kind: 'builtin', id: item.id })}
              />
            );
          })}
        </div>
      ) : state ? <div className="h34-empty">{term ? '没有找到匹配的技能。' : '目录暂时没有可展示的技能。'}</div> : null}
      <p className="h34-footnote"><ShieldCheck aria-hidden="true" /><span>内置技能随 Hemi 发布，可离线安装。{state?.catalogSource === 'online' ? `目录刷新于 ${state.checkedAt ? fmtDateTime(state.checkedAt) : '未知时间'}。` : state?.catalogSource === 'built-in' ? '当前为应用内置目录。' : '当前为上次成功目录。'}</span></p>
    </section>
  ) : (
    <section className="h34-list" aria-label="已安装技能">
      {localSearch('搜索名称或用途', '搜索已安装技能')}
      <div className="h34-cache-note">已安装技能 · {filteredInstalled.length} 个技能</div>
      {!state && showSkeleton ? <SkeletonGrid count={3} /> : filteredInstalled.length ? (
        <div className="h34-list-rows h34-grid">
          {filteredInstalled.map((item) => (
            <SkillCard
              key={item.id}
              added={item.enabled}
              name={item.title}
              description={item.description}
              badge={<span className="h37-badge" data-tone={item.enabled ? 'ok' : undefined}>{item.enabled ? '已启用' : '已停用'}</span>}
              meta={(
                <>
                  <span>{ORIGIN_LABELS[item.origin]}</span>
                  {item.github ? <span className="h34-mono">{item.github.repo}@{item.version}</span> : item.origin === 'market' ? <span>v{item.version}</span> : null}
                </>
              )}
              onOpen={() => select({ kind: 'installed', id: item.id })}
            />
          ))}
        </div>
      ) : state ? <div className="h34-empty">{term ? '没有找到匹配的技能。' : '还没有安装技能。去技能市场找一个，或导入本地文件夹。'}</div> : null}
      <p className="h34-footnote"><ShieldCheck aria-hidden="true" /><span>停用后新任务不再使用；在途任务仍用受理时的版本。卸载不删除本地导入的原始文件夹。</span></p>
    </section>
  );

  const MarketRoot = inline || remote ? 'section' : 'main';
  return (
    <MarketRoot ref={scrollRef} className="h34-market" aria-label="技能市场" data-detail-open={detailOpen ? 'true' : 'false'}>
      {topbarSlot ? createPortal(topbar, topbarSlot) : <div className="h34-inline-top">{topbar}</div>}
      <div className="h37-column h34-column" data-wide={detailOpen ? 'false' : 'true'}>
        {pendingApproval ? (
          <div className="h37-note h34-approval-alert" data-tone="warn" role="status">
            <ShieldAlert aria-hidden="true" />
            <span>有任务正在等待权限确认</span>
            <button type="button" className="h37-link h34-note-action" onClick={onBack}>返回对话处理</button>
          </div>
        ) : null}
        {state?.storageError ? <div className="h37-note h34-error" data-tone="danger" role="alert"><span>{state.storageError}</span></div> : null}
        {tab === 'builtin' && state?.catalogError ? (
          <div className="h37-note h34-alert" data-tone="warn" role="status">
            <span>{state.catalogError}。当前显示{state.catalogSource === 'built-in' ? '应用内置目录' : `上次成功目录（${state.checkedAt ? fmtDateTime(state.checkedAt) : '时间未知'}）`}，已安装技能可继续使用。</span>
            <button type="button" className="h37-link h34-note-action" disabled={Boolean(busy)} onClick={() => void act('刷新目录', () => api.refreshSkillCatalog())}>重试</button>
          </div>
        ) : null}
        {error ? (
          <div className="h37-note h34-error" data-tone="danger" role="alert">
            <span>{error}</span>
            <button type="button" className="h37-link h34-note-action" onClick={() => setError('')}>关闭</button>
          </div>
        ) : null}
        {detailOpen ? (
          <section className="h34-detail h37-drill" key={detailKey} aria-label="技能详情">
            <button type="button" className="h37-back h34-detail-back" onClick={clearSelection}><ArrowLeft aria-hidden="true" /> {TAB_LABELS[tab]}</button>
            {detail}
          </section>
        ) : (
          <div className="h34-list-wrap" key={tab}>{list}</div>
        )}
      </div>
      {confirmRemove ? (
        <div className="h37-scrim h34-confirm-backdrop" role="presentation">
          <div className="h37-dialog h34-confirm" role="dialog" aria-modal="true" aria-labelledby="h34-confirm-title">
            <h3 id="h34-confirm-title">卸载这个技能？</h3>
            <p>新任务将无法使用它。在途任务仍使用受理时的版本；本地导入的原文件夹不会被删除。</p>
            <div className="h37-dialog-foot">
              <button type="button" className="h37-btn h37-btn-secondary" onClick={() => setConfirmRemove(null)}>取消</button>
              <button type="button" className="h37-btn h37-btn-danger-solid" onClick={() => { const id = confirmRemove; setConfirmRemove(null); setSelected(null); void act('卸载技能', () => api.removeSkill(id)); }}>确认卸载</button>
            </div>
          </div>
        </div>
      ) : null}
      <button type="button" className="sr-only" onClick={onBack}>返回对话</button>
    </MarketRoot>
  );
}
