import type { FlowScope, ResourceRef } from '../types/api.js';
export type ResourceProgress = {
    phase: 'idle' | 'queued' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'cached' | 'preparing' | 'failed';
    received: number;
    total?: number;
    expiresAt?: number;
};
export const IDLE_PROGRESS: ResourceProgress = Object.freeze({ phase: 'idle', received: 0 });
export type ResourceTransfers = {
    subscribe(listener: () => void): () => void;
    getProgress(scope: FlowScope, ref: ResourceRef | null): ResourceProgress;
    invalidate(scope: FlowScope, ref: ResourceRef): void;
};
