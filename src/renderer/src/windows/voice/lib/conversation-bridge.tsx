import { createContext, useContext } from 'react';
import type { HemiVoiceBridge } from '@shared/protocol';

/** Conversation data/actions are supplied by the selected runtime. Local remains the default. */
export const ConversationBridgeContext = createContext<HemiVoiceBridge | null>(
  null,
);
export function useConversationBridge() {
  return useContext(ConversationBridgeContext) ?? window.hemiVoice;
}
export type ApplicationPage = 'home' | 'bot' | 'skills' | 'workflows' | 'settings' | 'usage';
export const ApplicationNavigationContext = createContext<{
  page: ApplicationPage;
  navigate: (page: ApplicationPage, settingsPage?: 'general' | 'models', settingsEnvironment?: 'local' | 'bot') => void;
} | null>(null);
export function useApplicationNavigation() {
  return useContext(ApplicationNavigationContext);
}

export const ConversationEnvironmentContext = createContext<'local' | 'bot'>(
  'local',
);
export const useConversationEnvironment = () =>
  useContext(ConversationEnvironmentContext);

/** Stable runtime identity isolates SDK resources across Bot replacements. */
export const ConversationEnvironmentIdContext = createContext('desktop-local');
export const useConversationEnvironmentId = () =>
  useContext(ConversationEnvironmentIdContext);

export const ConversationOnlineContext = createContext(true);
export const useConversationOnline = () =>
  useContext(ConversationOnlineContext);
