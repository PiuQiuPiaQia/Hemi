import { useMemo } from 'react';
import type { BotState } from '@shared/bot';
import type { OAuthLoginState } from '@shared/protocol';
import { OAuthAccountSection, type OAuthAccountApi } from '../voice/oauth-account-section';
import { botModelDirectory, callBot } from './bridge';

export function BotOAuthAccounts({ state, disabled, onConnected, onBusyChange }: {
  state: BotState; disabled: boolean; onConnected(): void; onBusyChange(busy: boolean): void;
}) {
  const identity = state.binding?.instanceId;
  const api = useMemo<OAuthAccountApi>(() => {
    const command = <T,>(method: 'oauth.state' | 'oauth.start' | 'oauth.answer' | 'oauth.cancel' | 'oauth.logout', params = {}) =>
      callBot<T>(window.hemiVoice.bot, method, { ...params, expectedInstanceId: identity });
    return {
      getOAuthLoginState: () => command<OAuthLoginState | null>('oauth.state'),
      startOAuthLogin: provider => command<OAuthLoginState>('oauth.start', { provider }),
      answerOAuthLogin: payload => command<OAuthLoginState | null>('oauth.answer', payload),
      cancelOAuthLogin: id => command<OAuthLoginState | null>('oauth.cancel', { id }),
      logoutOAuth: provider => command<{ ok: boolean }>('oauth.logout', { provider }),
    };
  }, [identity]);
  return <OAuthAccountSection api={api} target="bot" providers={botModelDirectory(state).providers}
    connectedAccounts={state.cache?.oauthAccounts?.filter(account => account.connected).map(account => account.provider)}
    disabled={disabled} onConnected={onConnected} onChanged={async () => {}} onBusyChange={onBusyChange} />;
}
