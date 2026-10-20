// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2aaf11850276b7d72eeb0ad5bed0e2948
// (= npm @flowgram.ai/runtime-js@1.0.16), MIT License. © Bytedance Ltd.
// vendor 子集入口。为什么 vendor：发布包不导出引擎与 executor 注册口（探针 E01/E06）、
// 取消不传播（C01）、任务全内存（R01）、CodeExecutor 自带 Lifetime bug（E08）——
// 见 requirements/059-node-workflows/technical-plan/runtime-vendoring.md。
// 上游升级＝对照 baseline commit 重做本目录 diff，不是 npm install；非 VENDOR-PATCH 处禁手改。

import { WorkflowRuntimeValidation } from './validation.mjs'
import { WorkflowRuntimeExecutor, WorkflowRuntimeEngine } from './engine.mjs'
import { StartExecutor, EndExecutor, ConditionExecutor } from './condition.mjs'

export { WorkflowPortType, WorkflowVariableType, FlowGramNode, ConditionOperator, WorkflowStatus, WorkflowMessageType } from './constants.mjs'
export { WorkflowRuntimeType } from './utils.mjs'
export { JSONSchemaValidator } from './json-schema-validator.mjs'
export { WorkflowRuntimeValidation, schemaFormat, cycleDetection, edgeSourceTargetExist, startEndNode } from './validation.mjs'
export { WorkflowRuntimeExecutor, WorkflowRuntimeEngine, WorkflowRuntimeTask } from './engine.mjs'
export { WorkflowRuntimeContext } from './context.mjs'
export {
  WorkflowRuntimeDocument,
  WorkflowRuntimeNode,
  WorkflowRuntimeEdge,
  WorkflowRuntimePort,
  flatSchema,
} from './document.mjs'
export {
  WorkflowRuntimeCache,
  WorkflowRuntimeIOCenter,
  WorkflowRuntimeMessageCenter,
  WorkflowRuntimeSnapshot,
  WorkflowRuntimeSnapshotCenter,
  WorkflowRuntimeStatus,
  WorkflowRuntimeStatusCenter,
  WorkflowRuntimeVariableStore,
  WorkflowRuntimeState,
  WorkflowRuntimeReporter,
  WorkflowRuntimeReport,
} from './domain.mjs'
export { StartExecutor, EndExecutor, ConditionExecutor, conditionRules, conditionHandlers } from './condition.mjs'

// VENDOR-PATCH（补强 #1）：上游引擎只能经 WorkflowApplication/Container 模块单例触达且
// executor 注册表在模块加载时灌死；vendor 版由工厂显式装配，宿主持 engine 引用直接 invoke。
// 上游等价代码：WorkflowRuntimeContainer.create() 里 `new WorkflowRuntimeExecutor(内置11类)`。
export function createWorkflowEngine({ executors = [], withBaseExecutors = true } = {}) {
  const base = withBaseExecutors ? [new StartExecutor(), new ConditionExecutor(), new EndExecutor()] : []
  const validation = new WorkflowRuntimeValidation()
  const executor = new WorkflowRuntimeExecutor([...base, ...executors])
  return new WorkflowRuntimeEngine({ Validation: validation, Executor: executor })
}
