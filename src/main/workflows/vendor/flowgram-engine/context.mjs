// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/domain/context/index.ts。
// VENDOR-PATCH：sub() 子上下文仅被 Loop 节点使用，Loop 不在 vendor 子集，一并剔除。

import { WorkflowRuntimeCache } from './domain.mjs'
import { WorkflowRuntimeDocument } from './document.mjs'
import { WorkflowRuntimeVariableStore, WorkflowRuntimeState } from './domain.mjs'
import {
  WorkflowRuntimeIOCenter,
  WorkflowRuntimeSnapshotCenter,
  WorkflowRuntimeStatusCenter,
  WorkflowRuntimeMessageCenter,
  WorkflowRuntimeReporter,
} from './domain.mjs'

export class WorkflowRuntimeContext {
  constructor(data) {
    this.id = crypto.randomUUID()
    this.cache = data.cache
    this.document = data.document
    this.variableStore = data.variableStore
    this.state = data.state
    this.ioCenter = data.ioCenter
    this.snapshotCenter = data.snapshotCenter
    this.statusCenter = data.statusCenter
    this.messageCenter = data.messageCenter
    this.reporter = data.reporter
  }
  init(params) {
    const { schema, inputs } = params
    this.cache.init()
    this.document.init(schema)
    this.variableStore.init()
    this.state.init(schema)
    this.ioCenter.init(inputs)
    this.snapshotCenter.init()
    this.statusCenter.init()
    this.messageCenter.init()
    this.reporter.init()
  }
  dispose() {
    this.cache.dispose()
    this.document.dispose()
    this.variableStore.dispose()
    this.state.dispose()
    this.ioCenter.dispose()
    this.snapshotCenter.dispose()
    this.statusCenter.dispose()
    this.messageCenter.dispose()
    this.reporter.dispose()
  }
  static create() {
    const cache = new WorkflowRuntimeCache()
    const document = new WorkflowRuntimeDocument()
    const variableStore = new WorkflowRuntimeVariableStore()
    const state = new WorkflowRuntimeState(variableStore)
    const ioCenter = new WorkflowRuntimeIOCenter()
    const snapshotCenter = new WorkflowRuntimeSnapshotCenter()
    const statusCenter = new WorkflowRuntimeStatusCenter()
    const messageCenter = new WorkflowRuntimeMessageCenter()
    const reporter = new WorkflowRuntimeReporter(ioCenter, snapshotCenter, statusCenter, messageCenter)
    return new WorkflowRuntimeContext({
      cache,
      document,
      variableStore,
      state,
      ioCenter,
      snapshotCenter,
      statusCenter,
      messageCenter,
      reporter,
    })
  }
}
