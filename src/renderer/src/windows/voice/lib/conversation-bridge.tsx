import { createContext, useContext } from 'react';
import type { HemiVoiceBridge } from '@shared/protocol';

/** Conversation data/actions are supplied by the selected runtime. Local remains the default. */
export const ConversationBridgeContext = createContext<HemiVoiceBridge | null>(
  null,
);
export function useConversationBridge() {
  return useContext(ConversationBridgeContext) ?? window.hemiVoice;
}
export type ApplicationPage = 'home' | 'bot' | 'skills' | 'workflows' | 'settings';
export const ApplicationNavigationContext = createContext<{
  page: ApplicationPage;
  navigate: (page: ApplicationPage) => void;
} | null>(null);
export function useApplicationNavigation() {
  return useContext(ApplicationNavigationContext);
}

export const ConversationEnvironmentContext = createContext<'local' | 'bot'>(
  'local',
);
export const useConversationEnvironment = () =>
  useContext(ConversationEnvironmentContext);

export const ConversationOnlineContext = createContext(true);
export const useConversationOnline = () =>
  useContext(ConversationOnlineContext);
