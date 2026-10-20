import path from 'node:path';

/** 只投影宿主掌握的诊断字段，绝不传出 key、配置原文或任意路径读权限。 */
export function describeRuntimeModel(config) {
  let endpoint = '';
  try { endpoint = new URL(config?.baseUrl).origin; } catch { /* 未配置 */ }
  return {
    requestedModel: String(config?.model ?? ''),
    provider: String(config?.name ?? ''),
    api: String(config?.api ?? ''),
    endpoint,
  };
}

export function buildRuntimeDiagnostic({
  conversationId, requestId, startedAt, config, executionConfig,
  version, platform, versions, userDataDir, isPackaged,
}) {
  return {
    conversationId, requestId, startedAt,
    instance: isPackaged ? 'production' : 'development',
    logPath: path.join(userDataDir, 'hemi.log'),
    runtime: { hemi: version, platform, node: versions.node, electron: versions.electron },
    dialogue: describeRuntimeModel(config),
    execution: describeRuntimeModel(executionConfig ?? config),
  };
}

export function buildRuntimeDiagnosticBlock(diagnostic) {
  return [
    '［当前实例与会话 · 宿主只读诊断］',
    JSON.stringify({ current: diagnostic }),
    '型号是本应用发送的请求标识，不证明中转服务的物理后端。dialogue 是主 agent 本轮首选配置，execution 是宿主冻结的执行配置，不代表所有角色子 agent 的实际调用。',
    '指定模型时主／子 agent 使用所选模型；自动路由时各角色使用配置的槽位。实际型号与备用切换以对应回合、子 agent 的调用记录为准，不把主／子 agent 描述为旧版脑／手分层。',
    '本块是本轮输入时冻结的可信配置与实例信息；询问本轮配置型号、供应商、实例或会话时直接依据本块回答，不重复调用工具。需要查询近期历史回合、耗时或进行跨回合比对时再使用 get_runtime_diagnostics，不要另启动任务猜测日志路径。配置型号不等于备用切换后的实际请求，缺少实际调用记录时如实说明。',
    '最近记录缺失时如实说明未留存；不能把其它实例、其它 conversationId 或旧日期当作本轮证据。思考未返回只表示没有可见思考，不能断言供应商没有推理。',
  ].join('\n');
}

/** 纯问候没有新任务授权，不从历史任务推导执行意图。 */
export function isGreetingOnly(text) {
  return /^(你好[呀啊]?|您好|嗨|hello|hi|hey)[!！。.?？\s]*$/i.test(String(text ?? '').trim());
}
