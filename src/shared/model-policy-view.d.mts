import type { ModelProfilesDirectory } from './protocol';
export function modelPolicyView(directory: ModelProfilesDirectory | null | undefined): { mainKey: string | null; mainName: string | null; ready: boolean; hint: string };
