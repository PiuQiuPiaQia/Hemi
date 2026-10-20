// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2aaf11850276b7d72eeb0ad5bed0e2948
// (= npm @flowgram.ai/runtime-js@1.0.16), MIT License. © Bytedance Ltd.
// 手工转写为 .mjs，逻辑与上游一致；与上游的偏差以 VENDOR-PATCH 标注。
// 上游出处：packages/runtime/interface/src（枚举与 DI token）。

export const WorkflowPortType = Object.freeze({
  Input: 'input',
  Output: 'output',
})

export const WorkflowVariableType = Object.freeze({
  String: 'string',
  Integer: 'integer',
  Number: 'number',
  Boolean: 'boolean',
  Object: 'object',
  Array: 'array',
  Map: 'map',
  DateTime: 'date-time',
  Null: 'null',
})

export const FlowGramNode = Object.freeze({
  Root: 'root',
  Start: 'start',
  End: 'end',
  LLM: 'llm',
  Code: 'code',
  Condition: 'condition',
  Loop: 'loop',
  Comment: 'comment',
  Group: 'group',
  BlockStart: 'block-start',
  BlockEnd: 'block-end',
  HTTP: 'http',
  Break: 'break',
  Continue: 'continue',
})

export const ConditionOperator = Object.freeze({
  EQ: 'eq',
  NEQ: 'neq',
  GT: 'gt',
  GTE: 'gte',
  LT: 'lt',
  LTE: 'lte',
  IN: 'in',
  NIN: 'nin',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'not_contains',
  IS_EMPTY: 'is_empty',
  IS_NOT_EMPTY: 'is_not_empty',
  IS_TRUE: 'is_true',
  IS_FALSE: 'is_false',
})

export const WorkflowStatus = Object.freeze({
  Pending: 'pending',
  Processing: 'processing',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'canceled',
})

export const WorkflowMessageType = Object.freeze({
  Log: 'log',
  Info: 'info',
  Debug: 'debug',
  Error: 'error',
  Warn: 'warning',
})

// VENDOR-PATCH：上游经 Symbol.for 供 inversify 容器取用；vendor 子集保留同名 token，
// 供宿主与 engine 上下文寻址（Loop 等自引用节点已剔除，仅保契约形状）。
export const IEngine = Symbol.for('Engine')
export const IExecutor = Symbol.for('Executor')
export const IValidation = Symbol.for('Validation')
