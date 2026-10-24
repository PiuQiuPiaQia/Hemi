export type UsageRecord = {
    /** 实际请求所属角色；旧账本未记录时保持缺省，不按模型反推。 */
    role?: 'main' | 'explorer' | 'oracle' | 'fixer' | 'designer' | 'auxiliary';
    purpose?: string;
    coverage?: 'complete' | 'unknown';
    costStatus?: 'unknown' | 'known';
    source: 'chat' | 'fallback' | 'summary' | 'title' | 'task';
    modelKey: string;
    modelName: string;
    requestedModel?: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    genMs: number;
    at: number;
    /** 任务执行行：聚合的调用次数与缺用量次数。 */
    calls?: number;
    missing?: number;
    /** 对话侧行：归属的任务（回炉/补判对应任务）。 */
    taskId?: string;
};
