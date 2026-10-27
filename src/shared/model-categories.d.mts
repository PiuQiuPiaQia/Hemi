export type ModelCategory = 'subscription' | 'newapi' | 'api' | 'local';
export const MODEL_CATEGORIES: ReadonlyArray<{ id: ModelCategory; label: string }>;
export function modelCategory(provider: { id?: string; oauthProvider?: string; configuration?: string; source?: string }, bot?: boolean): ModelCategory;
export function groupModelProviders<T extends { id?: string; oauthProvider?: string; configuration?: string; source?: string }>(providers: T[], bot?: boolean): Array<{ id: ModelCategory; label: string; providers: T[] }>;
