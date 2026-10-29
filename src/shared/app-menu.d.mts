export type AppMenuCommand = 'new-conversation' | 'open-workspace' | 'settings' | 'home' | 'bot' | 'skills' | 'workflows' | 'usage' | 'logs';
export type AppMenuId = 'file' | 'edit' | 'view' | 'help' | 'all';
export const APP_MENU_GROUPS: ReadonlyArray<{ id: Exclude<AppMenuId, 'all'>; label: string; accessKey: string }>;
export type AppMenuRequest = { menu: AppMenuId; x: number; y: number; enabledCommands: AppMenuCommand[] };
