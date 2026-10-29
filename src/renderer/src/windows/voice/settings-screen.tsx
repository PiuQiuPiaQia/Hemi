import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, Cpu, Menu, Mic, Monitor, Search, Settings as SettingsIcon } from 'lucide-react';

import { openExternal } from '@/shared/open-external';
import { SaveIndicator, type SaveState } from '@/components/save-indicator';
import {
  DOUBAO_CONSOLE_API_KEY_URL,
  TTS_VOICE_OPTIONS,
  type ConfigForm,
  type ModelProfilesDirectory,
  type TextModelConfigForm,
  type TtsConfigForm,
} from '@/shared/types';
import { AppTopBar } from '@/components/app-top-bar';
import { CallDockChip } from '@/windows/voice/call-dock';
import { AboutUpdateSection } from '@/windows/voice/about-update-section';
import { BrowserDecisionSection } from '@/windows/voice/browser-decision-model-section';
import { BrowserSection } from '@/windows/voice/browser-section';
import { FloatingOrbSection } from '@/windows/voice/floating-orb-section';
import { MemorySection } from '@/windows/voice/memory-section';
import { ModelProfilesSection } from '@/windows/voice/model-profiles-section';
import { NavRail } from '@/windows/voice/nav-rail';
import { AccessSection } from '@/windows/voice/access-section';
import { PushToTalkSection } from '@/windows/voice/push-to-talk-section';
import { VisionSection } from '@/windows/voice/vision-section';
import { WebSection } from '@/windows/voice/web-section';
import { BotSettings } from '@/windows/bot/settings';

/**
 * 设置整页视图。
 * 041 信息架构重组（2026-10-05，六分类候选基线）：通用 / 语音与通话 / 模型与路由 /
 * 电脑与浏览器 / 联网搜索 / 记忆；日志降为导航底部辅助入口；≤880 分类收进抽屉。
 * 旧五分类（模型 / 权限与控制 / 浏览器控制 / 联网搜索 / 记忆）经 PAGE_ALIASES 映射，
 * 032 修复条、记忆提示等历史直达目标不迁移调用方；模型「文本 / 语音」子 tab 拆为
 * 「模型与路由」「语音与通话」两个一级分类。
 *
 * 037 视觉系统（surfaces 稿「一个壳」）：设置是主窗口壳里的一页——图标栏（NavRail，
 * 设置钮高亮）＋二级栏（设置分页导航）＋内容列（h37-column / h37-page-head）。
 * 兼容标记：根节点保留 settings-shell（自驱动/真机脚本据此判定设置页）、
 * .settings-form-section 保留在模型区块外层（取证脚本就绪标记）。
 */

export type SettingsPage = 'general' | 'voice' | 'models' | 'control' | 'web' | 'memory';
export type SettingsEnvironment = 'local' | 'bot';

/** 旧直达目标别名（038/032 时代的五分类键）。 */
type LegacySettingsPage = 'model' | 'computer' | 'browser';

const PAGE_ALIASES: Record<LegacySettingsPage, SettingsPage> = {
  model: 'models',
  computer: 'control',
  browser: 'control',
};

const PAGES: Array<{ key: SettingsPage; label: string; icon: ReactNode }> = [
  { key: 'general', label: '通用', icon: <SettingsIcon aria-hidden="true" /> },
  { key: 'voice', label: '语音与通话', icon: <Mic aria-hidden="true" /> },
  { key: 'models', label: '模型与路由', icon: <Cpu aria-hidden="true" /> },
  { key: 'control', label: '电脑与浏览器', icon: <Monitor aria-hidden="true" /> },
  { key: 'web', label: '联网搜索', icon: <Search aria-hidden="true" /> },
  { key: 'memory', label: '记忆', icon: <Brain aria-hidden="true" /> },
];

/**
 * 2026-10-08 用户裁决：普通打开设置一律落第一分类「通用」——041 R-07 的
 * 「会话内记住上次所在页」实测很反直觉（每次打开都停在上次那页）已删除；
 * 修复条/「去设置自动路由」等显式带 initialPage 的直达不受影响。
 */

type SettingsScreenProps = {
  initialEnvironment?: SettingsEnvironment;
  /** 031 fixtures 用：注入确定性配置目录（不查桥）。 */
  modelProfilesFixture?: ModelProfilesDirectory | null;
  /** 旧目标兼容：model+voice 子 tab 解析为「语音与通话」页；新目标直接用六分类键。 */
  initialModelTab?: 'text' | 'voice';
  saving: boolean;
  /** 六分类键或旧五分类别名；缺省回到「通用」。 */
  initialPage?: SettingsPage | LegacySettingsPage;
  /** 深层定位锚点：recognition / browser-decision / browser / invoke。 */
  initialSection?: string;
  config: ConfigForm;
  modelConfig: TextModelConfigForm;
  ttsConfig: TtsConfigForm;
  primarySpeakerEnabled: boolean;
  onClose: () => void;
  /** 037：图标栏「技能」——先关设置再打开技能中心（缺省时等同回主页）。 */
  onOpenSkills?: () => void;
  onConfigChange: (next: Partial<ConfigForm>) => void;
  onModelConfigChange: (next: Partial<TextModelConfigForm>) => void;
  onTogglePrimarySpeaker: (enabled: boolean) => void;
  onPreviewTts: () => void;
  /** P2 自动保存：语音播报开关/音色即改即存；失败 reject，设置页就地显示。 */
  onSaveTts: (next: Partial<TtsConfigForm>) => Promise<void>;
  /** P2 自动保存：语音识别 Key 回车/离开输入框时保存。 */
  onSaveAsrKey: (key: string) => Promise<void>;
  /** 024：设置页打开时的持续通话压缩条（Home 仍持有语音状态；null＝没在通话）。 */
  callStatus?: { elapsedSeconds: number; muted: boolean } | null;
  onCallExpand?: () => void;
  onCallEnd?: () => void;
};

function resolveInitialPage(
  initialPage: SettingsPage | LegacySettingsPage | undefined,
  initialModelTab: 'text' | 'voice' | undefined,
): SettingsPage {
  if (initialPage === 'model') return initialModelTab === 'voice' ? 'voice' : 'models';
  if (initialPage === 'computer' || initialPage === 'browser') return 'control';
  if (initialPage) return initialPage;
  return 'general';
}

export function SettingsScreen({
  initialEnvironment = 'local',
  saving,
  initialPage,
  initialSection,
  config,
  modelProfilesFixture = null,
  initialModelTab,
  ttsConfig,
  primarySpeakerEnabled,
  onClose,
  onOpenSkills,
  onConfigChange,
  onTogglePrimarySpeaker,
  onPreviewTts,
  onSaveTts,
  onSaveAsrKey,
  callStatus,
  onCallExpand,
  onCallEnd,
}: SettingsScreenProps) {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [page, setPage] = useState<SettingsPage>(() => {
    const next = resolveInitialPage(initialPage, initialModelTab);
    return initialEnvironment === 'bot' && next !== 'models' && next !== 'memory' ? 'general' : next;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 深层定位：切页后滚动到锚点并短暂强调（browser-decision 同时展开 Jev 组）。
  const [pendingSection, setPendingSection] = useState<string | null>(initialSection ?? null);
  const [jevOpen, setJevOpen] = useState(initialSection === 'browser-decision');
  // 037 模型页 v2：下钻（供应商详情 / 添加供应商）时隐藏外层页头与 Jev 组。
  const [modelView, setModelView] = useState<'overview' | 'provider' | 'add'>('overview');
  const modelDrilled = page === 'models' && modelView !== 'overview';

  useEffect(() => {
    if (!pendingSection) return;
    const section = pendingSection;
    const frame = requestAnimationFrame(() => {
      if (section === 'browser-decision') setJevOpen(true);
      const el = document.getElementById(`settings-${section}`);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        el.classList.add('h37-flash');
        window.setTimeout(() => el.classList.remove('h37-flash'), 900);
      }
      setPendingSection(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingSection, page]);

  // 抽屉：Esc 关闭（037 记忆稿同款「背景不可操作，Esc/遮罩关闭」）。
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const goTo = (next: SettingsPage, section?: string) => {
    const perform = () => {
      setPage(next);
      if (section) setPendingSection(section);
    };
    perform();
  };
  const close = onClose;
  const openLog = () => {
    void window.hemiVoice?.revealLogFile();
  };
  const changeEnvironment = (next: SettingsEnvironment) => {
    if (next === environment) return;
    {
      setEnvironment(next);
      if (page !== 'general' && page !== 'models' && page !== 'memory') setPage('general');
      setModelView('overview');
      setPendingSection(null);
      setDrawerOpen(false);
    }
  };
  const pages = environment === 'bot'
    ? PAGES.filter((item) => item.key === 'general' || item.key === 'models' || item.key === 'memory')
    : PAGES;

  const navItems = (onPick: (key: SettingsPage) => void) =>
    pages.map((item) => (
      <button
        key={item.key}
        type="button"
        className="h37-settings-navitem"
        aria-current={page === item.key}
        onClick={() => onPick(item.key)}
      >
        {item.icon}
        {item.label}
      </button>
    ));
  const currentLabel = pages.find((item) => item.key === page)?.label ?? '';

  return (
    <main
      className="settings-shell compact-shell h24-shell h37-settings-shell min-h-dvh overflow-hidden"
      data-page="settings"
      data-settings-environment={environment}
    >
      <AppTopBar
        showBrand={false}
        back={{ label: '返回主窗口', onClick: close }}
        title={<>
          <span className="h37-settings-topbar-label app-topbar-label">{currentLabel}</span>
          <button
            type="button"
            className="h37-settings-drawer-trigger"
            aria-haspopup="dialog"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
            分类 · {currentLabel}
            <ChevronDown aria-hidden="true" />
          </button>
        </>}
        actions={
          <>
            {callStatus && onCallExpand && onCallEnd ? (
              <CallDockChip
                elapsedSeconds={callStatus.elapsedSeconds}
                muted={callStatus.muted}
                onExpand={onCallExpand}
                onEndCall={onCallEnd}
              />
            ) : null}
          </>
        }
      />

      <div className="h24-frame">
        <NavRail
          page="settings"
          onShowHome={close}
          onShowSkills={onOpenSkills ?? onClose}
          onOpenSettings={() => {}}
        />
        <section className="h24-workspace h37-settings-workspace">
          <nav className="settings-nav h37-settings-side" aria-label="设置导航">
            <p className="h37-settings-side-title">设置</p>
            {navItems(goTo)}
            {/* 041：日志降为导航底部辅助入口，不再是内容分组的成员。 */}
            {environment === 'local' ? <div className="h37-settings-navfoot">
              <button type="button" className="h37-settings-navitem" onClick={openLog}>
                日志文件
              </button>
            </div> : null}
          </nav>

          <div className="h37-scroll h37-settings-scroll">
            <div className="h37-column h37-settings-column">
              <label className="h37-settings-environment">
                <span>设置对象</span>
                <span className="h37-settings-select">
                  <select
                    className="h37-select"
                    aria-label="设置对象"
                    value={environment}
                    onChange={(event) => changeEnvironment(event.target.value as SettingsEnvironment)}
                  >
                    <option value="local">本地</option>
                    <option value="bot">Bot</option>
                  </select>
                  <ChevronDown aria-hidden="true" />
                </span>
              </label>
              {environment === 'bot' ? (
                <BotSettings page={page === 'models' || page === 'memory' ? page : 'general'} />
              ) : <>
              <div hidden={page !== 'memory'} className="h37-enter">
                <div className="h37-page-head">
                  <div>
                    <h2>记忆</h2>
                  </div>
                </div>
                <MemorySection />
              </div>

              {page !== 'memory' ? (
                <div key={page} className="h37-enter">
                  {page === 'general' ? (
                    <>
                      <div className="h37-page-head">
                        <div>
                          <h2>通用</h2>
                          <p>选择适合你的唤起方式。</p>
                        </div>
                      </div>
                      <section className="h37-section" id="settings-invoke">
                        <div className="h37-section-head">
                          <h3>唤起与显示</h3>
                        </div>
                        <div className="h37-group">
                          {/* 022 长按 Option（仅 macOS 渲染）／034 v3 悬浮球：自包含读写、立即生效。 */}
                          <PushToTalkSection />
                          <FloatingOrbSection />
                        </div>
                      </section>
                      {/* 044 应用内更新：版本号、检查更新与下载安装（自包含读写）。 */}
                      <AboutUpdateSection />
                    </>
                  ) : null}

                  {page === 'voice' ? (
                    <>
                      <div className="h37-page-head">
                        <div>
                          <h2>语音与通话</h2>
                          <p>调整 Hemi 怎样听、怎样说。</p>
                        </div>
                      </div>
                      <div className="h37-settings-stack">
                        {/* 013：首位说话人过滤（默认关；仅通话模式生效，切换后下一次通话生效）。
                            开关即时保存。P2：去掉「长按说话 → 去通用页设置」跳转行（重复入口，
                            设置本体在通用页）。 */}
                        <section className="h37-section">
                          <div className="h37-section-head">
                            <h3>通话偏好</h3>
                          </div>
                          <div className="h37-group">
                            <div className="h37-row">
                              <span className="h37-row-text">
                                <b>仅响应首位说话人</b>
                                <span>通话中只听第一位开口的人，下次通话生效。</span>
                              </span>
                              <button
                                type="button"
                                role="switch"
                                className="h37-switch"
                                aria-checked={primarySpeakerEnabled}
                                aria-label="仅响应首位说话人"
                                onClick={() => onTogglePrimarySpeaker(!primarySpeakerEnabled)}
                              />
                            </div>
                          </div>
                        </section>

                        <VoiceModelForm
                          saving={saving}
                          config={config}
                          ttsConfig={ttsConfig}
                          onConfigChange={onConfigChange}
                          onPreviewTts={onPreviewTts}
                          onSaveTts={onSaveTts}
                          onSaveAsrKey={onSaveAsrKey}
                        />
                      </div>
                    </>
                  ) : null}

                  {page === 'models' ? (
                    <div className="h37-settings-stack">
                      <div className="h37-page-head" hidden={modelDrilled}>
                        <div>
                          <h2>模型与路由</h2>
                        </div>
                      </div>
                      <div className="settings-form-section h37-settings-text">
                        {/* 031：供应商→多模型管理（列表＋详情＋逐模型测试；Key 只写不读）。 */}
                        <ModelProfilesSection
                          fixtureDirectory={modelProfilesFixture}
                          onViewChange={setModelView}
                        />
                      </div>
                      {/* 041：Jev 决策模型配置归模型页（浏览器页只留开关与跳转）。 */}
                      {!modelDrilled ? (
                        <BrowserDecisionSection
                          open={jevOpen}
                          onToggle={() => setJevOpen((prev) => !prev)}
                          onBack={() => goTo('control', 'browser')}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {page === 'control' ? (
                    <>
                      <div className="h37-page-head">
                        <div>
                          <h2>电脑与浏览器</h2>
                          <p>管理操作能力与所需授权。</p>
                        </div>
                      </div>
                      <div className="h37-settings-stack">
                        <VisionSection onShowModel={() => goTo('models')} />
                        <div id="settings-browser">
                          <BrowserSection onConfigureDecision={() => goTo('models', 'browser-decision')} />
                        </div>
                        <AccessSection />
                      </div>
                    </>
                  ) : null}

                  {page === 'web' ? (
                    <>
                      <div className="h37-page-head">
                        <div>
                          <h2>联网搜索</h2>
                          <p>搜索资料，读取公开网页。</p>
                        </div>
                      </div>
                      <WebSection />
                    </>
                  ) : null}
                </div>
              ) : null}
              </>}
            </div>
          </div>
        </section>
      </div>

      {/* ≤880 分类抽屉：同六分类＋日志；选择后关闭并切页，Esc/遮罩关闭。 */}
      {drawerOpen ? (
        <div className="h37-settings-drawer-scrim" onClick={() => setDrawerOpen(false)}>
          <aside
            className="h37-settings-drawer"
            role="dialog"
            aria-label="设置分类"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="h37-settings-side-title">设置</p>
            {navItems((key) => {
              setDrawerOpen(false);
              goTo(key);
            })}
            {environment === 'local' ? <div className="h37-settings-navfoot">
              <button
                type="button"
                className="h37-settings-navitem"
                onClick={() => {
                  setDrawerOpen(false);
                  openLog();
                }}
              >
                日志文件
              </button>
            </div> : null}
          </aside>
        </div>
      ) : null}
    </main>
  );
}

/** 语音页「语音识别（豆包）＋语音播报」：字段与行为同 031，041 从模型子 tab 独立成页。 */
function VoiceModelForm({
  saving,
  config,
  ttsConfig,
  onConfigChange,
  onPreviewTts,
  onSaveTts,
  onSaveAsrKey,
}: {
  saving: boolean;
  config: ConfigForm;
  ttsConfig: TtsConfigForm;
  onConfigChange: (next: Partial<ConfigForm>) => void;
  onPreviewTts: () => void;
  onSaveTts: (next: Partial<TtsConfigForm>) => Promise<void>;
  onSaveAsrKey: (key: string) => Promise<void>;
}) {
  // P2：两组各自的保存状态（与模型页同一套 SaveIndicator）。
  const tts = useAutoSave();
  const asr = useAutoSave();
  const saveTts = (next: Partial<TtsConfigForm>) => tts.run(() => onSaveTts(next));
  const saveKey = () => {
    if (!config.apiKey.trim() || asr.state === 'saving') return;
    void asr.run(() => onSaveAsrKey(config.apiKey));
  };

  return (
    <>
      <section className="h37-section">
        <div className="h37-section-head">
          <h3>语音播报</h3>
          <span className="h37-aside">
            <SaveIndicator state={tts.state} idleText="自动保存" errorText={tts.error} />
          </span>
        </div>
        <div className="h37-group">
          <div className="h37-row">
            <span className="h37-row-text">
              <b>把回应念出来</b>
            </span>
            <button
              type="button"
              role="switch"
              className="h37-switch"
              aria-checked={ttsConfig.ttsEnabled}
              aria-label="开启语音播报"
              onClick={() => saveTts({ ttsEnabled: !ttsConfig.ttsEnabled })}
            />
          </div>
          <div className="h37-row h37-settings-stack-row">
            <span className="h37-row-text">
              <label htmlFor="tts-voice" className="h37-row-title">
                音色
              </label>
            </span>
            <span className="h37-row-end">
              <span className="h37-settings-select">
                <select
                  id="tts-voice"
                  className="h37-select"
                  value={ttsConfig.ttsVoice}
                  onChange={(event) => saveTts({ ttsVoice: event.target.value })}
                  disabled={!ttsConfig.ttsEnabled}
                >
                  {TTS_VOICE_OPTIONS.map((voice) => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
              <button
                type="button"
                className="h37-btn h37-btn-secondary"
                disabled={saving || !ttsConfig.ttsEnabled || !ttsConfig.hasApiKey}
                onClick={onPreviewTts}
              >
                试听
              </button>
            </span>
          </div>
        </div>
      </section>

      <section className="h37-section" id="settings-recognition">
        <div className="h37-section-head">
          <h3>语音识别服务</h3>
          <span className="h37-aside h37-settings-aside-row">
            <SaveIndicator state={asr.state} errorText={asr.error} />
            <span className="h37-badge" data-tone={config.hasApiKey ? 'ok' : 'warn'}>
              {config.hasApiKey ? '已配 Key' : '未配 Key'}
            </span>
          </span>
        </div>
        <div className="h37-group">
          <div className="h37-settings-form">
            <div className="h37-field">
              <label htmlFor="doubao-api-key">豆包 API Key</label>
              <input
                id="doubao-api-key"
                type="password"
                className="h37-input"
                value={config.apiKey}
                onChange={(event) => onConfigChange({ apiKey: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  saveKey();
                }}
                onBlur={saveKey}
                placeholder={config.hasApiKey ? '粘贴新 Key 可替换当前密钥，回车保存' : '粘贴 API Key，回车保存'}
                autoComplete="new-password"
                aria-describedby="doubao-api-key-help"
              />
              <p className="h37-help" id="doubao-api-key-help">
                已加密保存在本机。还没有 API Key？
                <button
                  type="button"
                  className="h37-link"
                  onClick={() => openExternal(DOUBAO_CONSOLE_API_KEY_URL)}
                >
                  去火山引擎控制台创建 ↗
                </button>
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** P2 设置页自动保存的状态机：saving → saved（1.6s 后回 idle）／error（保留原因直到下次保存）。 */
function useAutoSave() {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (timer.current) window.clearTimeout(timer.current);
    setState('saving');
    setError('');
    try {
      await action();
      setState('saved');
      timer.current = window.setTimeout(() => setState('idle'), 1600);
    } catch (failure) {
      setState('error');
      setError(failure instanceof Error && failure.message ? failure.message : '保存失败，请重试。');
    }
  };
  return { state, error, run };
}
