import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Menu, MenuItem } from '@/components/menu';
import type { AgentEnvironmentSnapshot } from '@shared/protocol';
import { MemorySection } from '../voice/memory-section';
import type { BotMethod, BotState } from '@shared/bot';
import { BotButton, BotDialog } from './dialogs';
import { BotModelsSettings } from './models-settings';
import { BotPairing } from './pairing';
import { useApplicationNavigation } from '../voice/lib/conversation-bridge';
import {BotCapabilitiesSettings} from './capabilities-settings';
import {BotSkillsSettings} from './skills-settings';
import './styles.css';

type Dialog = 'pairing' | 'address' | 'stop' | 'remove' | 'forget' | 'update';

/** Settings use the desktop Bot bridge directly; local configuration APIs are never substituted. */
export function BotSettings({page = 'general'}: {page?: 'general' | 'models' | 'memory'}) {
  const api = window.hemiVoice?.bot;
  const [state, setState] = useState<BotState | null>(null);
  const [error, setError] = useState('');
  const navigation = useApplicationNavigation();
  useEffect(() => {
    if (!api) return;
    let active = true;
    let events = 0;
    const off = api.onChanged((next) => {
      events++;
      if (active) {
        setState(next);
        setError('');
      }
    });
    void api
      .getState()
      .then((next) => {
        if (active && !events) setState(next);
      })
      .catch((e: unknown) => {
        if (active && !events) setError(e instanceof Error ? e.message : '无法读取 Bot 设置。');
      });
    return () => {
      active = false;
      off();
    };
  }, [api]);

  if (error || !api)
    return (
      <p className="h-bot-error" role="alert">
        {error || 'Bot 连接不可用。'}
      </p>
    );
  if (!state)
    return (
      <p className="h37-section-foot" role="status">
        正在读取 Bot 设置…
      </p>
    );
  if (!state.binding)
    return (
      <div className="h37-enter">
        <div className="h37-page-head">
          <div>
            <h2>通用</h2>
            <p>连接云服务器后，在这里管理 Bot。</p>
          </div>
        </div>
        <section className="h37-section">
          <div className="h37-group">
            <SettingsRow title="尚未连接 Bot" description="让 Hemi 在云端持续工作。">
              <button
                type="button"
                className="h37-btn h37-btn-secondary"
                onClick={() => navigation?.navigate('bot')}
              >
                连接 Bot
              </button>
            </SettingsRow>
          </div>
        </section>
      </div>
    );
  if (page === 'models') return <BotModelsSettings key={state.binding.instanceId} state={state} />;
  if (page === 'memory') return <BotMemorySettings key={state.binding.instanceId} instanceId={state.binding.instanceId} />;
  return <ConnectedBotSettings key={state.binding.instanceId} state={state} />;
}

function BotMemorySettings({ instanceId }: { instanceId: string }) {
  const api = window.hemiVoice.bot;
  const inspect = useCallback(() => api.command<AgentEnvironmentSnapshot>('agent-environment.inspect', { expectedInstanceId: instanceId }), [api, instanceId]);
  const readFile = useCallback((path: string) => api.command<{ path: string; text: string }>('agent-environment.read-file', { path, expectedInstanceId: instanceId }), [api, instanceId]);
  return <><div className="h37-page-head"><div><h2>记忆</h2></div></div><MemorySection inspect={inspect} readFile={readFile} /></>;
}

function SettingsRow({
  title,
  description,
  children,
  className = '',
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`h37-row h37-bot-settings-row ${className}`}>
      <span className="h37-row-text">
        <b>{title}</b>
        {description ? <span>{description}</span> : null}
      </span>
      {children ? <span className="h37-row-end">{children}</span> : null}
    </div>
  );
}

function ConnectedBotSettings({ state }: { state: BotState }) {
  const api = window.hemiVoice.bot;
  const [screen, setScreen] = useState<Dialog | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [host, setHost] = useState(state.binding?.host ?? '');
  const [pending, setPending] = useState<BotMethod | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [componentMenuOpen, setComponentMenuOpen] = useState(false);
  const componentMenuRef = useRef<HTMLButtonElement>(null);
  const busy = !!pending || !!state.busy;
  const instanceId = state.binding!.instanceId;
  const call = async <T = unknown,>(method: BotMethod, params?: Record<string, unknown>) => {
    const request = { ...params, expectedInstanceId: instanceId };
    if (!api.commandResult) return api.command<T>(method, request);
    // Preserve error codes across Electron's context bridge for pairing recovery.
    const reply = await api.commandResult<T>(method, request);
    if (!reply.ok) throw Object.assign(new Error(reply.message), { code: reply.code });
    return reply.result;
  };
  async function perform(method: BotMethod, params?: Record<string, unknown>) {
    if (busy) return;
    setPending(method);
    setError('');
    setNotice('');
    try {
      const result = await call<{ cancelled?: boolean; online?: boolean; error?: string }>(method, params);
      if (method === 'connection.reconnect' && !result.online) throw new Error(result.error || '连接仍未恢复，请检查服务器网络后重试。');
      setScreen(null);
      if (method === 'component.ensure-current') return;
      if (!result?.cancelled) setNotice(method === 'diagnostics.export' ? '诊断已导出' : method === 'connection.reconnect' ? '已重新连接 Bot' : '已完成');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未能确认，请重新连接核对。');
    } finally {
      setPending(null);
    }
  }
  const action = (label: string, onClick: () => void, offline = false) => (
    <button
      type="button"
      className="h37-btn h37-btn-secondary"
      disabled={busy || offline}
      onClick={onClick}
    >
      {label}
    </button>
  );
  const openAddress = () => {
    setHost(state.binding?.host ?? '');
    setError('');
    setScreen('address');
  };
  const status = state.stoppedConfirmed ? '已确认停止' : state.online ? '运行中' : '状态待核对';
  const component = state.componentStatus;
  const checkingComponent = component?.phase === 'checking' || component?.phase === 'updating';
  const componentMessage = component?.phase === 'checking' ? '正在后台检查更新…'
    : component?.phase === 'updating' ? `正在后台更新${component.localVersion ? `至 v${component.localVersion}` : ''}…`
    : component?.phase === 'failed' ? `自动更新未完成：${component.message || '请稍后重试。'}`
    : component?.phase === 'waiting' ? component.message || '将在空闲时自动更新。'
    : component?.phase === 'current' ? '已是最新版本。' : '空闲时自动更新。';
  const title = screen
    ? {
        pairing: '连接新设备',
        address: '修改连接地址',
        stop: '停止云端 Bot？',
        remove: '停止并移除连接？',
        forget: '仅移除本机绑定？',
        update: '重新部署云端组件？',
      }[screen]
    : '';
  const operation = {
    stop: 'service.stop',
    remove: 'connection.remove',
    forget: 'connection.forget',
    update: 'component.update',
  } as const;

  if (skillsOpen) return <BotSkillsSettings state={state} onBack={() => setSkillsOpen(false)}/>;

  return (
    <div className="h37-enter">
      <div className="h37-page-head">
        <div>
          <h2>通用</h2>
          <p>
            管理云端连接、设备与常驻服务。
          </p>
        </div>
      </div>
      <section className="h37-section">
        <div className="h37-section-head">
          <h3>连接与设备</h3>
        </div>
        <div className="h37-group">
          <SettingsRow title="服务器地址" description={state.binding?.host}>
            {action('修改地址', openAddress)}
          </SettingsRow>
          <SettingsRow
            title={state.online ? '已连接' : '连接已断开'}
            description={
              !state.online
                ? state.error || '云端 Bot 可能仍在运行。'
                : '文件与任务在云服务器上运行。'
            }
          >
            {state.online
              ? action('断开连接', () => void perform('connection.disconnect'))
              : <BotButton loading={pending === 'connection.reconnect'} disabled={busy} onClick={() => void perform('connection.reconnect')}>{pending === 'connection.reconnect' ? '正在连接…' : '重新连接'}</BotButton>}
          </SettingsRow>
          <SettingsRow
            title="默认空间"
            description={<code>{state.cache?.defaultDir ?? '暂无记录'}</code>}
          />
          <SettingsRow
            title="最后连接"
            description={
              state.lastConnectedAt
                ? new Date(state.lastConnectedAt).toLocaleString()
                : '暂无记录'
            }
          />
          <SettingsRow title="连接新设备" description="通过二维码将手机等设备连接到 Bot。">
            {action('管理设备', () => setScreen('pairing'))}
          </SettingsRow>
        </div>
      </section>
      <section className="h37-section">
        <div className="h37-section-head">
          <h3>常驻服务</h3>
        </div>
        <div className="h37-group">
          <SettingsRow title="运行状态" description={status}>
            {state.cache?.enabled && !state.stoppedConfirmed
              ? action('停止 Bot', () => setScreen('stop'), !state.online)
              : action('启动 Bot', () => void perform('service.start'))}
          </SettingsRow>
          <SettingsRow className="h-bot-component-row" title="云端组件" description={<>
            {state.binding?.componentVersion
              ? `v${state.binding.componentVersion.version} · ${state.binding.componentVersion.build.slice(0, 8)}`
              : state.binding?.version ?? '暂无记录'}
            <br />
            每 6 小时自动检查一次。{componentMessage}
            {component?.checkedAt ? <><br />上次检查：{new Date(component.checkedAt).toLocaleString()}。</> : null}
          </>}>
            {action(component?.phase === 'failed' ? '重试更新' : '检查更新', () => void perform('component.ensure-current'), !state.online || checkingComponent)}
            <button
              ref={componentMenuRef}
              type="button"
              className="h37-btn h37-btn-ghost h37-btn-icon h37-btn-sm"
              aria-label="云端组件更多操作"
              title="云端组件更多操作"
              aria-haspopup="menu"
              aria-expanded={componentMenuOpen}
              disabled={busy || !state.online || checkingComponent}
              onClick={() => setComponentMenuOpen(!componentMenuOpen)}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
          </SettingsRow>
          <SettingsRow title="诊断信息" description="导出连接与运行信息，帮助排查问题。">
            {action('导出诊断', () => void perform('diagnostics.export'))}
          </SettingsRow>
        </div>
      </section>
      <BotCapabilitiesSettings state={state} onOpenSkills={() => setSkillsOpen(true)}/>
      <section className="h37-section">
        <div className="h37-section-head">
          <h3>移除连接</h3>
        </div>
        <div className="h37-group">
          <SettingsRow title="停止并移除连接" description="停止云端服务，再移除本机绑定。">
            {action('停止并移除', () => setScreen('remove'), !state.online)}
          </SettingsRow>
          <SettingsRow title="仅移除本机绑定" description="移除本机连接与缓存，云端数据保留。">
            {action('移除绑定', () => setScreen('forget'))}
          </SettingsRow>
        </div>
      </section>
      <Menu
        open={componentMenuOpen}
        onClose={() => setComponentMenuOpen(false)}
        anchorRef={componentMenuRef}
        placement="anchor-down"
      >
        <MenuItem
          label="重新部署云端组件…"
          disabled={busy || !state.online || checkingComponent}
          onClick={() => {
            setComponentMenuOpen(false);
            setError('');
            setScreen('update');
          }}
        />
      </Menu>
      {notice ? (
        <p className="h37-section-foot" role="status">
          {notice}
        </p>
      ) : null}
      {error && !screen ? (
        <p role="alert" className="h-bot-error">
          {error}
        </p>
      ) : null}
      {screen === 'pairing' ? (
        <BotPairing
          state={state}
          call={call}
          onClose={() => setScreen(null)}
          onBack={() => setScreen(null)}
        />
      ) : null}
      {screen && screen !== 'pairing' ? (
        <BotDialog
          title={title}
          busy={busy}
          onClose={() => setScreen(null)}
          footer={
            <>
              <BotButton
                disabled={busy}
                onClick={() => {
                  setScreen(null);
                  setError('');
                }}
              >
                取消
              </BotButton>
              <BotButton
                primary
                disabled={busy || (screen === 'address' && !host.trim())}
                onClick={() =>
                  void (screen === 'address'
                    ? perform('connection.address', { host })
                    : perform(operation[screen]))
                }
              >
                {busy
                  ? '正在处理…'
                  : screen === 'address'
                    ? '保存'
                    : screen === 'update'
                      ? '空闲时重新部署'
                      : screen === 'forget'
                        ? '仅移除本机绑定'
                        : screen === 'remove'
                          ? '停止并移除'
                          : '停止 Bot'}
              </BotButton>
            </>
          }
        >
          {screen === 'address' ? (
            <label className="h-bot-field">
              SSH 地址
              <input value={host} disabled={busy} onChange={(e) => setHost(e.target.value)} />
            </label>
          ) : null}
          {screen === 'stop' || screen === 'remove' ? (
            <p>将停止当前任务并关闭自动启动，云端会话、模型配置与文件保留。</p>
          ) : null}
          {screen === 'forget' ? (
            <p>只移除本机连接和缓存。云端 Bot 可能仍在运行，会话、文件与模型配置保留。</p>
          ) : null}
          {screen === 'forget' || screen === 'remove' ? (
            <details className="h-bot-small">
              <summary>云端清理说明</summary>
              <p>
                通过 SSH 执行 <code>systemctl --user disable --now hemi-bot</code> 停止服务。
              </p>
              <p>
                需要彻底清理时，删除 <code>~/.config/systemd/user/hemi-bot.service</code> 和{' '}
                <code>~/.local/share/hemi-bot</code>，再执行{' '}
                <code>systemctl --user daemon-reload</code>
                。这会永久删除云端会话、附件和模型凭据。默认空间及其他工作目录文件保留。
              </p>
              <p>如需撤销模型密钥，请到相应供应商后台撤销。</p>
            </details>
          ) : null}
          {screen === 'update' ? <p>重新部署会短暂重启 Bot，现有会话和文件保留。</p> : null}
          {error ? (
            <p role="alert" className="h-bot-error">
              {error}
            </p>
          ) : null}
        </BotDialog>
      ) : null}
    </div>
  );
}
