import { useState } from 'react';
import { QrCode } from 'lucide-react';
import type { BotMethod, BotState } from '@shared/bot';
import { BotButton, BotDialog } from './dialogs';
import { BotPairing } from './pairing';

export function BotSettings({
  state,
  call,
  onClose,
  onSync,
  initialScreen = 'settings',
}: {
  state: BotState;
  call: <T = unknown>(
    method: BotMethod,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  onClose: () => void;
  onSync: () => void;
  initialScreen?: 'settings' | 'pairing';
}) {
  const [screen, setScreen] = useState<
    | 'settings'
    | 'pairing'
    | 'address'
    | 'stop'
    | 'remove'
    | 'forget'
    | 'update'
  >(initialScreen);
  const [host, setHost] = useState(state.binding?.host ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = pending || !!state.busy;
  async function perform(
    method: BotMethod,
    params?: Record<string, unknown>,
    close = false,
  ) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await call<{ cancelled?: boolean }>(method, params);
      if (close) onClose();
      else {
        setScreen('settings');
        if (!result?.cancelled)
          setNotice(
            method === 'diagnostics.export'
              ? '诊断已导出'
              : '已完成',
          );
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '操作未能确认，请重新连接核对。',
      );
    } finally {
      setPending(false);
    }
  }
  const title = {
    settings: 'Bot 设置',
    pairing: '连接新设备',
    address: '修改连接地址',
    stop: '停止云端 Bot？',
    remove: '停止并移除连接？',
    forget: '仅移除本机绑定？',
    update: '重新部署云端组件？',
  }[screen];
  const operation = {
    stop: 'service.stop',
    remove: 'connection.remove',
    forget: 'connection.forget',
    update: 'component.update',
  } as const;
  if (screen === 'pairing') return <BotPairing state={state} call={call} onClose={onClose} onBack={() => setScreen('settings')}/>;
  return (
    <BotDialog
      title={title}
      busy={busy}
      onClose={onClose}
      footer={
        screen === 'settings' ? (
          <BotButton onClick={onClose} disabled={busy}>
            完成
          </BotButton>
        ) : (
          <>
            <BotButton
              disabled={busy}
              onClick={() => {
                setScreen('settings');
                setError('');
              }}
            >
              返回
            </BotButton>
            <BotButton
              primary
              disabled={
                busy ||
                (screen === 'address' && !host.trim())
              }
              onClick={() =>
                void (screen === 'address'
                    ? perform('connection.address', { host })
                    : perform(
                        operation[screen as keyof typeof operation],
                        undefined,
                        screen === 'remove' || screen === 'forget',
                      ))
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
        )
      }
    >
      {screen === 'settings' && (
        <>
          <p className="h-bot-host">{state.binding?.host}</p>
          <dl className="h-bot-dl">
            <dt>连接</dt>
            <dd>{state.online ? '已连接' : '连接已断开'}</dd>
            <dt>常驻服务</dt>
            <dd>
              {state.stoppedConfirmed?'已确认停止':state.online?'运行中':'状态待核对'}
            </dd>
            <dt>默认空间</dt>
            <dd>
              <code>{state.cache?.defaultDir}</code>
            </dd>
            <dt>可用模型</dt>
            <dd>{state.cache?.models.length ?? 0} 个</dd>
            <dt>组件版本</dt>
            <dd>{state.binding?.version}</dd>
            <dt>最后连接</dt>
            <dd>
              {state.lastConnectedAt
                ? new Date(state.lastConnectedAt).toLocaleString()
                : '暂无记录'}
            </dd>
          </dl>
          <div className="h-bot-setting-actions">
            <BotButton disabled={busy} onClick={() => setScreen('pairing')}>
              <QrCode size={14} aria-hidden="true" />
              连接新设备
            </BotButton>
            <BotButton disabled={busy || !state.online} onClick={onSync}>
              添加模型
            </BotButton>
            <BotButton disabled={busy} onClick={() => setScreen('address')}>
              修改连接地址
            </BotButton>
            <BotButton
              disabled={busy}
              onClick={() => void perform('diagnostics.export')}
            >
              导出诊断
            </BotButton>
            <BotButton
              disabled={busy || !state.online}
              onClick={() => setScreen('update')}
            >
              维护云端组件
            </BotButton>
            {state.cache?.enabled ? (
              <BotButton
                disabled={busy || !state.online}
                onClick={() => setScreen('stop')}
              >
                停止 Bot
              </BotButton>
            ) : (
              <BotButton
                disabled={busy}
                onClick={() => void perform('service.start')}
              >
                启动 Bot
              </BotButton>
            )}
            <BotButton
              disabled={busy || !state.online}
              onClick={() =>
                void perform('connection.disconnect', undefined, true)
              }
            >
              断开连接
            </BotButton>
            <BotButton
              disabled={busy || !state.online}
              onClick={() => setScreen('remove')}
            >
              停止并移除连接
            </BotButton>
            <BotButton disabled={busy} onClick={() => setScreen('forget')}>
              仅移除本机绑定
            </BotButton>
          </div>
        </>
      )}
      {screen === 'address' && (
        <>
          <label className="h-bot-field">
            SSH 地址
            <input
              value={host}
              disabled={busy}
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
        </>
      )}
      {(screen === 'stop' || screen === 'remove') && (
        <>
          <p>
            将停止当前任务并关闭自动启动，云端会话、模型配置与文件保留。
          </p>
        </>
      )}
      {screen === 'forget' && (
        <>
          <p>
            只移除本机连接和缓存。云端 Bot 可能仍在运行，会话、文件与模型配置保留。
          </p>
        </>
      )}
      {(screen === 'forget' || screen === 'remove') && (
        <details className="h-bot-small">
          <summary>云端清理说明</summary>
          <p>
            通过 SSH 执行 <code>systemctl --user disable --now hemi-bot</code>{' '}
            停止服务。
          </p>
          <p>
            需要彻底清理时，删除{' '}
            <code>~/.config/systemd/user/hemi-bot.service</code> 和{' '}
            <code>~/.local/share/hemi-bot</code>，再执行{' '}
            <code>systemctl --user daemon-reload</code>
            。这会永久删除云端会话、附件和模型凭据。默认空间及其他工作目录文件保留。
          </p>
          <p>如需撤销模型密钥，请到相应供应商后台撤销。</p>
        </details>
      )}
      {screen === 'update' && (
        <p>
          重新部署会短暂重启 Bot，现有会话和文件保留。
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="h-bot-error">
          {error}
        </p>
      )}
    </BotDialog>
  );
}
