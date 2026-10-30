import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ChevronRight, Code, Download, ExternalLink, FileText, FolderOpen,
  ListChecks, Plus, RefreshCw, Save, Search, ShieldAlert, ShieldCheck, Star, Trash2,
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

/** 详情页头：48px 图标块＋标签＋名称＋说明＋外链，右侧主操作。 */
function DetailHero({ tag, title, description, links, meta, cta }: {
  tag: ReactNode;
  title: string;
  description: string;
  links?: ReactNode;
  /** 标题块下的元信息行（作者·星标·语言·更新），市场详情用它替代独立概况卡。 */
  meta?: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <div className="h34-hero">
      <span className="h37-tile h34-hero-tile" data-tone="g"><FileText aria-hidden="true" /></span>
      <div className="h34-hero-copy">
        <div className="h34-detail-tag">{tag}</div>
        <h2>{title}</h2>
        <p>{description}</p>
        {meta ? <div className="h34-hero-meta">{meta}</div> : null}
        {links ? <div className="h34-links">{links}</div> : null}
      </div>
      {cta ? <div className="h34-hero-cta">{cta}</div> : null}
    </div>
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

function FileSection({ title, count, files }: {
  title: string;
  count?: string;
  files: Array<{ path: string; size?: string }>;
}) {
  return (
    <section className="h37-section">
      <div className="h37-section-head"><h3>{title}</h3>{count ? <span className="h37-count">{count}</span> : null}</div>
      <div className="h37-group h34-file-list">
        {files.map((file) => (
          <div className="h37-row h34-file-row" key={file.path} title={file.path}>
            <FileText aria-hidden="true" />
            <span className="h34-mono">{file.path}</span>
            {file.size ? <em>{file.size}</em> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceSection({ title, text, collapsible = false, hint = '' }: {
  title: string;
  text: string;
  collapsible?: boolean;
  hint?: string;
}) {
  const body = <pre className="h37-group">{text}</pre>;
  if (!collapsible) {
    return (
      <section className="h37-section h34-source">
        <div className="h37-section-head"><h3>{title}</h3></div>
        {body}
      </section>
    );
  }
  return (
    <details className="h37-section h34-source h34-fold">
      <summary><span className="h34-fold-title">{title}</span>{hint ? <span className="h37-count">{hint}</span> : null}<ChevronRight aria-hidden="true" /></summary>
      {body}
    </details>
  );
}

/** 折叠区块：来源细节、超长原文默认收起，保持确认页「先看到要装什么」。 */
function FoldSection({ title, hint = '', children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="h37-section h34-fold">
      <summary><span className="h34-fold-title">{title}</span>{hint ? <span className="h37-count">{hint}</span> : null}<ChevronRight aria-hidden="true" /></summary>
      {children}
    </details>
  );
}

/** 详情页吸底安装条：安装动作常驻可见；进行中左侧状态行带阶段与已等秒数。 */
function InstallBar({ phase, elapsed, installed, locked, onInstall, onManage }: {
  phase: '' | 'read' | 'save';
  elapsed: number;
  installed: boolean;
  locked: boolean;
  onInstall: () => void;
  onManage: () => void;
}) {
  return (
    <div className="h34-confirm-bar" data-busy={phase ? 'true' : 'false'}>
      <span className="h34-bar-status" role="status">
        {phase ? <span className="h37-spinner" aria-hidden="true" /> : null}
        {phase === 'read'
          ? `正在读取 GitHub 来源文件（已等 ${elapsed} 秒）`
          : phase === 'save'
            ? '正在核对并保存…'
            : '只保存文件，不运行任何东西'}
      </span>
      <span className="h34-cta-row">
        {installed ? (
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-lg" disabled={locked} onClick={onManage}>管理已安装版本</button>
        ) : null}
        <button type="button" className="h37-btn h37-btn-primary h37-btn-lg" disabled={locked} onClick={onInstall}>
          {phase === 'read' ? '正在读取…' : phase === 'save' ? '正在安装…' : installed ? '更新到最新并启用' : '安装并启用'}
        </button>
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

  // 034 v5（2026-10-09 用户裁决）：详情页用市场元数据秒开，安装点击后才拉来源——
  // 「读取来源文件（钉固定提交）→ 核对并保存」两阶段流水线，进度在安装条上给。
  // 文件清单/原文是可选的验看区（安装后自动展开，装前也可手动先看）。
  const [panel, setPanel] = useState<{ state: 'idle' | 'loading' | 'shown' | 'error'; preview?: SkillsmpPreview }>({ state: 'idle' });
  const [installPhase, setInstallPhase] = useState<'' | 'read' | 'save'>('');
  const previewCache = useRef(new Map<string, SkillsmpPreview>());
  const selectedRef = useRef<Selected>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const stillOn = useCallback((skillId: string) => {
    const current = selectedRef.current;
    return current !== null && current.kind === 'mp' && current.skill.id === skillId;
  }, []);

  /** 拉取预览（固定提交快照）供验看区展示；迟到的结果不落到已换看的条目上。 */
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
        setPanel({ state: 'error' });
        setError(result.reason || '来源读取失败');
        return null;
      }
      previewCache.current.set(skill.id, result.preview);
      setPanel({ state: 'shown', preview: result.preview });
      return result.preview;
    } catch (cause) {
      if (stillOn(skill.id)) {
        setPanel({ state: 'error' });
        setError(cause instanceof Error ? cause.message : '来源读取失败');
      }
      return null;
    }
  }, [api, stillOn]);

  /** 安装流水线：读取来源（阶段一，产出钉提交与摘要）→ 核对并保存（阶段二）。 */
  const runInstall = useCallback(async (skill: SkillsmpSkill) => {
    setError('');
    setInstallPhase('read');
    try {
      const preview = await loadPanel(skill);
      if (!preview) return;
      setInstallPhase('save');
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
        setError(result.reason || '安装未完成');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安装未完成');
    } finally {
      setInstallPhase('');
    }
  }, [api, loadPanel, reload]);

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
      // 详情页 + 验看区展开（v5：详情页用元数据秒开，验看区是懒加载的）。
      // 选未安装的条目（fixtures 的 nano-pdf 已预装，选中它吸底条会是更新态）。
      setQuery('pdf');
      void runSearch('pdf', 'stars').then(() => {
        void api.searchSkillsMp({ query: 'pdf', sortBy: 'stars' }).then((result) => {
          const skills = result.ok ? result.skills ?? [] : [];
          const skill = skills.find((entry) => entry.id === 'demo-excel-helper-skill-md') ?? skills[0];
          if (skill) {
            select({ kind: 'mp', skill });
            void loadPanel(skill);
          }
        }).catch(() => {});
      });
    }
    if (demo === 'mp-detail') {
      // idle 详情页：只选中不拉来源（验「元数据秒开 + 安装流程说明」的排版）。
      void api.searchSkillsMp({ query: 'pdf', sortBy: 'stars' }).then((result) => {
        const skill = result.ok ? (result.skills ?? [])[0] : null;
        if (skill) select({ kind: 'mp', skill });
      }).catch(() => {});
    }
    if (demo === 'builtin') setTab('builtin');
  }, [api, demo, runSearch, loadPanel]);
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

  const clearSelection = () => { selectedRef.current = null; setSelected(null); setSourceText(''); setUpdateCheck(null); setPanel({ state: 'idle' }); };
  const switchTab = (next: Tab) => { setTab(next); clearSelection(); };
  // selectedRef 同步更新：select 后同刻发起的 loadPanel/runInstall（fixtures demo 即如此）
  // 也要能通过 stillOn 守卫，等 effect 异步刷 ref 会误判成「已换看」。
  const select = (next: NonNullable<Selected>) => {
    selectedRef.current = next;
    setSelected(next);
    setSourceText('');
    setUpdateCheck(null);
    setPanel({ state: 'idle' });
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

  const installedBody = (item: InstalledSkill) => (
    <>
      <DetailHero
        tag={`${ORIGIN_LABELS[item.origin]} · 已安装`}
        title={item.title}
        description={item.description}
        links={item.github ? (
          <>
            {item.github.url ? <button type="button" className="h37-link h34-link" onClick={() => openExternal(item.github!.url)}><ExternalLink aria-hidden="true" /> SkillsMP 页面</button> : null}
            <button type="button" className="h37-link h34-link" onClick={() => openExternal(githubTreeUrl(item.github!))}><Code aria-hidden="true" /> GitHub（固定提交）</button>
          </>
        ) : null}
      />
      <div className="h34-detail-actions">
        <button type="button" className="h37-btn h37-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('切换启用状态', () => api.setSkillEnabled(item.id, !item.enabled))}>{item.enabled ? '停用技能' : '启用技能'}</button>
        <button type="button" className="h37-btn h37-btn-ghost" disabled={Boolean(busy)} onClick={() => void openSource(item.id)}>查看原文</button>
        {!remote ? <button type="button" className="h37-btn h37-btn-ghost" disabled={Boolean(busy)} onClick={() => void act('打开目录', () => api.revealSkill(item.id))}><FolderOpen aria-hidden="true" /> 打开目录</button> : null}
        <button type="button" className="h37-btn h37-btn-ghost h37-btn-danger" disabled={Boolean(busy)} onClick={() => setConfirmRemove(item.id)}><Trash2 aria-hidden="true" /> 卸载</button>
      </div>
      <FoldSection title="来源与完整性" hint={item.github ? item.github.repo : (item.origin === 'local' ? '本地' : '内置')}>
        <dl className="h37-group h34-kv">
          <div><dt>标识</dt><dd className="h34-mono">{item.name}</dd></div>
          <div><dt>作者</dt><dd>{item.author}</dd></div>
          <div><dt>版本</dt><dd>{item.github ? `GitHub 提交 ${item.version}` : item.version}</dd></div>
          {item.github ? (
            <>
              <div><dt>仓库</dt><dd className="h34-mono">{item.github.repo}{item.github.path ? ` / ${item.github.path}` : ''}</dd></div>
              <div><dt>固定提交</dt><dd className="h34-mono" title={item.github.commit}>{item.github.commit.slice(0, 12)}</dd></div>
              <div><dt>条目</dt><dd className="h34-mono">{item.github.entryId}</dd></div>
            </>
          ) : <div><dt>来源</dt><dd>{item.origin === 'local' ? item.sourcePath : 'Hemi 内置目录'}</dd></div>}
        </dl>
      </FoldSection>
      {item.origin === 'skillsmp' && item.github ? (
        <section className="h37-section">
          <div className="h37-section-head"><h3>更新</h3></div>
          <div className="h37-group h34-update-box">
            <button type="button" className="h37-btn h37-btn-secondary" disabled={updateCheck?.checking === true || Boolean(busy)} onClick={() => void runUpdateCheck(item)}>
              {updateSpinner ? <span className="h37-spinner" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />} {updateCheck?.checking === true ? '正在检查…' : '检查更新'}
            </button>
            {updateCheck && updateCheck.checking !== true ? (
              <p role="status">
                {updateCheck.status === 'up-to-date' ? `已是最新（固定提交 ${updateCheck.commit?.slice(0, 12) ?? item.version}）。` : null}
                {updateCheck.status === 'update-available' ? `来源有新提交 ${updateCheck.commit?.slice(0, 12) ?? ''}。` : null}
                {updateCheck.status === 'source-changed' ? `${updateCheck.reason ?? '来源已变化'}。已安装版本仍按原提交可用。` : null}
                {updateCheck.status === 'unavailable' ? `${updateCheck.reason ?? '暂无法核对来源'}。已安装版本不受影响。` : null}
                {updateCheck.status === 'update-available' && updateCheck.githubUrl ? (
                  <button type="button" className="h37-link h34-link" onClick={() => { select({ kind: 'mp', skill: { ...EMPTY_SKILL, id: item.github!.entryId, name: item.name, author: item.author, githubUrl: updateCheck.githubUrl!, skillUrl: item.github!.url || null } }); }}>查看新版并更新</button>
                ) : null}
                {updateCheck.status === 'source-changed' ? (
                  <button type="button" className="h37-link h34-link" onClick={() => { select({ kind: 'mp', skill: { ...EMPTY_SKILL, id: item.github!.entryId, name: item.name, author: item.author, githubUrl: item.github!.githubUrl, skillUrl: item.github!.url || null } }); }}>按原来源重新检查</button>
                ) : null}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
      <FileSection title="包含文件" count={`${item.files.length} 个`} files={item.files.map((file) => ({ path: file }))} />
      <div className="h37-note h34-permission-note" data-tone="g"><ShieldCheck aria-hidden="true" /><span>技能只是做事的方法说明；实际工具调用仍按权限设置确认。</span></div>
      {sourceText ? <SourceSection title="SKILL.md 原文" text={sourceText} /> : null}
    </>
  );

  const detail = (() => {
    if (selected?.kind === 'mp') {
      // v5：详情页用市场元数据秒开；安装点击后才拉来源（两阶段进度在吸底安装条上）。
      const skill = selected.skill;
      const preview = panel.state === 'shown' ? panel.preview : null;
      const locked = Boolean(busy) || installPhase !== '';
      return (
        <>
          <DetailHero
            tag="SkillsMP 市场"
            title={skill.name}
            description={skill.description || '（SkillsMP 未提供描述，以来源文件为准）'}
            meta={(
              <>
                <span>{skill.author || '未知'}</span>
                {skill.stars !== null ? <span><Star aria-hidden="true" />{fmtStars(skill.stars)}</span> : null}
                {skill.contentLanguage ? <span>{skill.contentLanguage.toUpperCase()}</span> : null}
                {skill.updatedAt ? <span>收录 {fmtTime(skill.updatedAt)}</span> : null}
              </>
            )}
            links={(
              <>
                {skill.skillUrl ? <button type="button" className="h37-link h34-link" onClick={() => openExternal(skill.skillUrl)}><ExternalLink aria-hidden="true" /> SkillsMP 页面</button> : null}
                {skill.githubUrl ? <button type="button" className="h37-link h34-link" onClick={() => openExternal(skill.githubUrl)}><Code aria-hidden="true" /> GitHub 仓库</button> : null}
              </>
            )}
          />
          {skill.githubUrl ? (
            <>
              {!preview ? (
                <section className="h37-section" aria-label="安装流程说明">
                  <div className="h37-section-head"><h3>点安装后会怎样</h3></div>
                  <div className="h37-group h34-steps">
                    <div className="h37-row h34-step">
                      <Download aria-hidden="true" />
                      <div><strong>读取来源</strong><small>按固定提交从 GitHub 拉取全部文件；大技能或弱网可能要等十几秒，进度显示在底部。</small></div>
                    </div>
                    <div className="h37-row h34-step">
                      <ListChecks aria-hidden="true" />
                      <div><strong>逐个核对</strong><small>每个文件与 GitHub 文件树摘要比对，不一致即拒绝安装。</small></div>
                    </div>
                    <div className="h37-row h34-step">
                      <Save aria-hidden="true" />
                      <div><strong>只保存</strong><small>不运行脚本、不装依赖；装完即可启用，随时可停用或卸载。</small></div>
                    </div>
                  </div>
                </section>
              ) : null}
              {preview ? (
                <>
                  <FileSection
                    title="将保存的文件"
                    count={`${preview.files.length} 个 · ${fmtBytes(preview.totalBytes)}`}
                    files={preview.files.map((file) => ({ path: file.path, size: fmtBytes(file.size) }))}
                  />
                  <div className="h37-note h34-permission-note" data-tone="g"><ShieldCheck aria-hidden="true" /><span>只保存这些文件，不运行脚本、不装依赖；内容与本页清单不一致时安装会拒绝。</span></div>
                  {selectedInstalled ? (
                    <div className="h37-note h34-permission-note" data-tone="warn" role="status">
                      <ShieldAlert aria-hidden="true" />
                      <span>已安装{selectedInstalled.github ? `提交 ${selectedInstalled.version}` : ` v${selectedInstalled.version}`}；再次安装会把同一技能换成上面列出的文件。</span>
                    </div>
                  ) : null}
                  <FoldSection title="来源与完整性" hint="仓库 · 提交 · 摘要">
                    <dl className="h37-group h34-kv">
                      <div><dt>作者</dt><dd>{preview.author || '未知'}</dd></div>
                      <div><dt>仓库</dt><dd className="h34-mono">{preview.repo}{preview.dirPath ? ` / ${preview.dirPath}` : ''}</dd></div>
                      <div><dt>固定提交</dt><dd className="h34-mono" title={preview.commit}>{preview.commit.slice(0, 12)}</dd></div>
                      <div><dt>内容摘要</dt><dd className="h34-mono" title={preview.bundleSha256}>SHA-256 {preview.bundleSha256.slice(0, 16)}…</dd></div>
                    </dl>
                  </FoldSection>
                  <SourceSection title="SKILL.md 原文" text={preview.skillMd} collapsible hint={`${preview.skillMd.length.toLocaleString('zh-CN')} 字`} />
                </>
              ) : panel.state === 'loading' ? (
                <div className="h37-group h34-loading" role="status">
                  <span className="h37-spinner" aria-hidden="true" />
                  <p>正在从 GitHub 读取来源文件{installPhase === 'read' && installElapsed >= 3 ? `（已等 ${installElapsed} 秒）` : ''}…<br /><small>文件多或网络慢时可能要等半分钟以上。</small></p>
                </div>
              ) : panel.state === 'error' ? (
                <div className="h37-note h34-panel-error" data-tone="warn" role="status">
                  <ShieldAlert aria-hidden="true" />
                  <span>来源文件读取失败，可能是网络不通。可重试，或稍后再装。</span>
                  <button type="button" className="h37-btn h37-btn-secondary" disabled={locked} onClick={() => { setPanel({ state: 'idle' }); void loadPanel(skill); }}>重试</button>
                </div>
              ) : (
                <div className="h37-group h34-panel-teaser">
                  <FileText aria-hidden="true" />
                  <div>
                    <strong>装前可先看内容</strong>
                    <small>安装时从 GitHub 固定提交读取全部文件并逐个核对；想先确认，点右侧按钮查看文件与原文。</small>
                  </div>
                  <button type="button" className="h37-btn h37-btn-secondary" disabled={locked} onClick={() => void loadPanel(skill)}>查看将保存的文件</button>
                </div>
              )}
              <InstallBar
                phase={installPhase}
                elapsed={installElapsed}
                installed={Boolean(selectedInstalled)}
                locked={locked}
                onInstall={() => void runInstall(skill)}
                onManage={() => selectedInstalled && select({ kind: 'installed', id: selectedInstalled.id })}
              />
            </>
          ) : (
            <div className="h37-note" data-tone="warn" role="status"><ShieldAlert aria-hidden="true" /><span>该条目没有 GitHub 来源，无法添加到 Hemi。</span></div>
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
            description={selectedBuiltin.description}
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
          {installedItem ? (
            <div className="h34-detail-actions">
              {builtinUpdateAvailable ? <button type="button" className="h37-btn h37-btn-primary" disabled={Boolean(busy)} onClick={() => void act('更新技能', () => api.installMarketSkill(selectedBuiltin.id))}>更新到 v{selectedBuiltin.version}</button> : null}
              <button type="button" className="h37-btn h37-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('切换启用状态', () => api.setSkillEnabled(installedItem.id, !installedItem.enabled))}>{installedItem.enabled ? '停用技能' : '启用技能'}</button>
              <button type="button" className="h37-btn h37-btn-ghost" disabled={Boolean(busy)} onClick={() => void openSource(installedItem.id)}>查看原文</button>
              {!remote ? <button type="button" className="h37-btn h37-btn-ghost" disabled={Boolean(busy)} onClick={() => void act('打开目录', () => api.revealSkill(installedItem.id))}><FolderOpen aria-hidden="true" /> 打开目录</button> : null}
              <button type="button" className="h37-btn h37-btn-ghost h37-btn-danger" disabled={Boolean(busy)} onClick={() => setConfirmRemove(installedItem.id)}><Trash2 aria-hidden="true" /> 卸载</button>
            </div>
          ) : null}
          <KvSection title="来源">
            <div><dt>标识</dt><dd className="h34-mono">{selectedBuiltin.name}</dd></div>
            <div><dt>作者</dt><dd>{selectedBuiltin.author}</dd></div>
            <div><dt>版本</dt><dd>v{selectedBuiltin.version}</dd></div>
            <div><dt>来源</dt><dd>Hemi 内置目录</dd></div>
            <div><dt>目录发布</dt><dd>{state?.publishedAt ?? '未知'}</dd></div>
          </KvSection>
          <FileSection title="包含文件" count={`${selectedBuiltin.files.length} 个`} files={selectedBuiltin.files.map((file) => ({ path: file }))} />
          <div className="h37-note h34-permission-note" data-tone="g"><ShieldCheck aria-hidden="true" /><span>安装不会运行脚本；任务使用时仍按权限设置确认。</span></div>
          {sourceText ? <SourceSection title="SKILL.md 原文" text={sourceText} /> : null}
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
