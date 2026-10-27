import { useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { HemiVoiceBridge, ModelProviderView, OAuthLoginState, OAuthProvider } from '@/shared/types';
import { copyTextViaBridge } from '@/lib/use-clipboard-copy';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const ACCOUNTS: Array<{ id: OAuthProvider; name: string; description: string }> = [
  { id: 'openai', name: 'ChatGPT', description: '使用 ChatGPT 账号授权的模型与额度' },
  { id: 'anthropic', name: 'Claude', description: '使用 Claude 账号授权的模型与额度' },
  { id: 'github-copilot', name: 'GitHub Copilot', description: '通过设备验证码连接 Copilot 账号' },
  { id: 'bigmodel', name: 'GLM Coding Plan', description: '登录 BigModel 账号，使用编程套餐的 ZCode 通道' },
];

export type OAuthAccountApi = Pick<HemiVoiceBridge, 'getOAuthLoginState' | 'startOAuthLogin' | 'answerOAuthLogin' | 'cancelOAuthLogin' | 'logoutOAuth'>;

export function OAuthAccountSection({ providers, onlyProvider, disabled = false, onConnected, onChanged, onBusyChange, api, target = 'local', connectedAccounts }: {
  providers: ModelProviderView[];
  onlyProvider?: OAuthProvider;
  disabled?: boolean;
  onConnected: (providerId: string) => void;
  onChanged: () => Promise<unknown>;
  onBusyChange?: (busy: boolean) => void;
  api?: OAuthAccountApi;
  target?: 'local' | 'bot';
  connectedAccounts?: OAuthProvider[];
}) {
  const bridge = api ?? window.hemiVoice;
  const [state, setState] = useState<OAuthLoginState | null>(null);
  const [dialogProvider, setDialogProvider] = useState<OAuthProvider | null>(null);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [copyNote, setCopyNote] = useState('');
  const watch = useRef<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const latestRevision = useRef(-1);
  const latestId = useRef<string | null>(null);
  const generation = useRef(0);
  const busy = pending || state?.phase === 'login';
  const callbacks = useRef({ onConnected, onChanged, onBusyChange });
  callbacks.current = { onConnected, onChanged, onBusyChange };
  const apply = (next: OAuthLoginState | null) => {
    if (next && next.id === latestId.current && next.revision <= latestRevision.current) return;
    latestId.current = next?.id ?? null;
    latestRevision.current = next?.revision ?? -1;
    setState(next);
    if (next?.phase === 'login' && (!onlyProvider || next.provider === onlyProvider)) {
      watch.current = next.id;
      setDialogProvider(next.provider);
    }
  };

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const epoch = generation.current;
        const next = await bridge.getOAuthLoginState();
        if (disposed) return;
        if (epoch !== generation.current) { timer = setTimeout(() => void poll(), 600); return; }
        apply(next);
      } catch { if (!disposed) setError('账号登录状态读取失败，请稍后重试。'); }
      if (!disposed) timer = setTimeout(() => void poll(), 600);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [onlyProvider, bridge]);

  useEffect(() => {
    callbacks.current.onBusyChange?.(busy);
    return () => callbacks.current.onBusyChange?.(false);
  }, [busy]);
  useEffect(() => { setValue(''); setCopyNote(''); }, [state?.prompt?.id, state?.id]);
  useEffect(() => {
    if (state?.phase !== 'success' || state.id !== watch.current || !state.providerId) return;
    watch.current = null;
    void callbacks.current.onChanged().then(() => {
      setDialogProvider(null);
      callbacks.current.onConnected(state.providerId!);
    }).catch(() => setError('登录成功，但模型列表刷新失败，请返回模型页重试。'));
  }, [state]);

  const command = async (run: () => Promise<unknown>) => {
    setPending(true); setError('');
    try { await run(); }
    catch (reason) {
      const message = (reason instanceof Error ? reason.message : '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
      setError(/^(环境变量|模型目录|请先完成|请先更新 Bot|恢复连接后|Bot 连接|账号登录仅允许|登录输入无效|请选择一个登录方式|这个登录步骤)/.test(message) ? message : '操作未完成，请稍后重试；正在进行的登录可先取消。');
    }
    finally { setPending(false); }
  };
  const start = (provider: OAuthProvider) => {
    generation.current++; latestId.current = null; latestRevision.current = -1;
    setDialogProvider(provider); setState(null); setStarting(true); setValue(''); setCopyNote('');
    void command(async () => {
      try {
        const next = await bridge.startOAuthLogin(provider);
        watch.current = next.id; apply(next);
      } finally { setStarting(false); }
    });
  };
  const close = () => {
    if (pending) return;
    if (state?.phase === 'login') {
      void command(async () => {
        const next = await bridge.cancelOAuthLogin(state.id);
        apply(next);
        if (next?.phase !== 'login') setDialogProvider(null);
      });
    } else setDialogProvider(null);
  };
  const shownState = !starting && state?.provider === dialogProvider ? state : null;
  const prompt = shownState?.phase === 'login' ? shownState.prompt : null;
  const accountName = ACCOUNTS.find(account => account.id === dialogProvider)?.name ?? '账号';
  const submitPrompt = () => {
    if (!shownState || !prompt || pending || (prompt.type !== 'text' && !value.trim())) return;
    void command(async () => {
      apply(await bridge.answerOAuthLogin({ id: shownState.id, promptId: prompt.id, value }));
      setValue('');
    });
  };
  return (
    <section className="h37-section h-oauth" aria-label="账号登录">
      <div className="h37-section-head"><h3>账号登录</h3></div>
      <p className="h37-help">{target === 'bot' ? '在系统浏览器为此 Bot 单独授权。凭据加密保存在服务器，由 Bot 自动续期，电脑断开后仍可使用。' : '在系统浏览器授权，登录后即可选择模型。登录凭据加密保存在本机，到期自动刷新。'}</p>
      <div className="h37-group">
        {ACCOUNTS.filter(account => !onlyProvider || account.id === onlyProvider).map(account => {
          const connected = connectedAccounts ? connectedAccounts.includes(account.id) : providers.some(provider => provider.oauthProvider === account.id && provider.hasApiKey);
          return <div className="h37-row h-oauth-row" key={account.id}>
            <div className="h-oauth-label"><b>{account.name}</b><span>{account.description}</span></div>
            <div className="h37-actions">
              {connected ? <span className="h37-badge" data-tone="ok">已登录</span> : null}
              <button type="button" className="h37-btn h37-btn-ghost" aria-haspopup="dialog" disabled={disabled || busy} onClick={event => {
                returnFocus.current = event.currentTarget; start(account.id);
              }}>{connected ? '重新登录' : '登录'}<ExternalLink size={14} aria-hidden /></button>
              {connected ? <button type="button" className="h37-btn h37-btn-ghost" disabled={disabled || busy} onClick={() => void command(async () => {
                generation.current++; await bridge.logoutOAuth(account.id); await callbacks.current.onChanged(); apply(null);
              })}>退出登录</button> : null}
            </div>
          </div>;
        })}
      </div>
      <Dialog open={dialogProvider !== null} onOpenChange={(open, details) => {
        if (!open) { details.cancel(); close(); }
      }}>
        <DialogContent className="h-oauth-dialog" showCloseButton={false} finalFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>{target === 'bot' ? '为 Bot 登录 ' : '登录 '}{accountName}</DialogTitle>
            <DialogDescription>{target === 'bot' ? '在系统浏览器完成授权，登录凭据将加密保存在此 Bot 的服务器上。' : '在系统浏览器完成授权，Hemi 会自动更新模型列表。'}</DialogDescription>
          </DialogHeader>
          <DialogClose type="button" className="h37-access-dialog-close h-oauth-close" aria-label={shownState?.phase === 'login' ? '取消登录并关闭' : '关闭登录授权'} disabled={pending}><X aria-hidden="true" /></DialogClose>
          <div className="h-oauth-progress" aria-live="polite">
            <p className="h-oauth-status" role={shownState?.phase === 'failed' ? 'alert' : 'status'}>
              {(!shownState && !error) || shownState?.phase === 'login' ? <span className="h37-spinner" aria-hidden="true" /> : null}
              {shownState?.message ?? (error ? '授权未能开始' : '正在准备账号授权…')}
            </p>
            {shownState?.userCode ? <div className="h-oauth-device">
              <span className="h37-help">设备验证码</span>
              <div className="h37-actions"><code className="h-oauth-code">{shownState.userCode}</code><button type="button" className="h37-btn h37-btn-secondary" onClick={() => void copyTextViaBridge(shownState.userCode!).then(ok => setCopyNote(ok ? '验证码已复制' : '未能复制，请手动输入验证码'))}>复制验证码</button></div>
            </div> : null}
            {prompt?.type === 'select' ? <div className="h37-actions" aria-label={prompt.message}>{prompt.options?.map((option, index) => <button type="button" className={`h37-btn ${index === 0 ? 'h37-btn-primary' : 'h37-btn-secondary'}`} disabled={pending} key={option.id} onClick={() => void command(async () => apply(await bridge.answerOAuthLogin({ id: shownState!.id, promptId: prompt.id, value: option.id })))}>{option.label}</button>)}</div> : prompt ? <div className="h-oauth-prompt">
              <label htmlFor={`oauth-${prompt.id}`}>{prompt.message}</label>
              <div className="h37-actions">
                <input id={`oauth-${prompt.id}`} className="h37-input" type={prompt.type === 'secret' ? 'password' : 'text'} autoComplete="off" autoFocus spellCheck={false} placeholder={prompt.placeholder} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submitPrompt(); }
                }} />
                <button type="button" className="h37-btn h37-btn-primary" disabled={pending || (prompt.type !== 'text' && !value.trim())} onClick={submitPrompt}>继续</button>
              </div>
            </div> : null}
            {copyNote ? <p className="h37-help" role="status">{copyNote}</p> : null}
            {error ? <p className="h37-error-text" role="alert">{error}</p> : null}
          </div>
          <div className="h37-dialog-foot h-oauth-footer">
            {shownState?.url ? <button type="button" className="h37-link h37-start" onClick={() => void copyTextViaBridge(shownState.url!).then(ok => setCopyNote(ok ? '登录链接已复制，请在浏览器打开' : '未能复制登录链接，请重试'))}>复制登录链接</button> : <span className="h37-start" />}
            <DialogClose type="button" className="h37-btn h37-btn-ghost" disabled={pending}>{shownState?.phase === 'login' || starting ? '取消登录' : '关闭'}</DialogClose>
            {!starting && (shownState?.phase === 'failed' || shownState?.phase === 'cancelled' || (!shownState && error)) && dialogProvider ? <button type="button" className="h37-btn h37-btn-primary" disabled={pending} onClick={() => start(dialogProvider)}>重新登录</button> : null}
          </div>
        </DialogContent>
      </Dialog>
      {!dialogProvider && error ? <p className="h37-error-text" role="alert">{error}</p> : null}
    </section>
  );
}
