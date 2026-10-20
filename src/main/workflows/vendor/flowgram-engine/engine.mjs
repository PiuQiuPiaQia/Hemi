// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/domain/{executor,task,context,engine,container}/**。
// VENDOR-PATCH（vendoring 方案补强 #1）：
// - 不再提供 WorkflowRuntimeContainer/WorkflowApplication 模块级单例与 console.log 噪音；
//   WorkflowRuntimeEngine 构造已参数化（{Validation, Executor}），由 createWorkflowEngine 工厂
//   显式装配（见 index.mjs）。executeNode 传给执行器的 container 上游指向全局容器（Loop 自引用
//   用），vendor 子集该节点类不保留，container 恒为 null（保留字段形状，契约不破）。
// - invoke() 校验失败路径也 dispose 上下文（上游只 dispose 正常路径）；dispose 对报告相关 center
//   均为 no-op，reporter.export() 仍可完整导出，宿主行为无差异。

import { FlowGramNode, WorkflowStatus } from './constants.mjs'
import { uuid, compareNodeGroups } from './utils.mjs'
import { WorkflowRuntimeContext } from './context.mjs'

export { WorkflowRuntimeContext }

// src/domain/executor/index.ts
export class WorkflowRuntimeExecutor {
  constructor(nodeExecutors) {
    this.nodeExecutors = new Map()
    nodeExecutors.forEach((executor) => {
      this.register(executor)
    })
  }
  register(executor) {
    this.nodeExecutors.set(executor.type, executor)
  }
  async execute(context) {
    const nodeType = context.node.type
    const nodeExecutor = this.nodeExecutors.get(nodeType)
    if (!nodeExecutor) {
      throw new Error(`No executor found for node type ${nodeType}`)
    }
    return nodeExecutor.execute(context)
  }
}

// src/domain/task/index.ts
export class WorkflowRuntimeTask {
  constructor(params) {
    this.id = uuid()
    this.context = params.context
    this.processing = params.processing
  }
  cancel() {
    this.context.statusCenter.workflow.cancel()
    const cancelNodeIDs = this.context.statusCenter.getStatusNodeIDs(WorkflowStatus.Processing)
    cancelNodeIDs.forEach((nodeID) => {
      this.context.statusCenter.nodeStatus(nodeID).cancel()
    })
  }
  static create(params) {
    return new WorkflowRuntimeTask(params)
  }
}

// src/domain/engine/index.ts
export class WorkflowRuntimeEngine {
  constructor(service) {
    this.validation = service.Validation
    this.executor = service.Executor
  }
  invoke(params) {
    const context = WorkflowRuntimeContext.create()
    context.init(params)
    const valid = this.validate(params, context)
    if (!valid) {
      return WorkflowRuntimeTask.create({ processing: Promise.resolve({}), context })
    }
    const processing = this.process(context)
    processing.then(
      () => {
        context.dispose()
      },
      () => {
        context.dispose()
      }
    )
    return WorkflowRuntimeTask.create({ processing, context })
  }
  async executeNode(params) {
    const { node, context } = params
    if (!this.canExecuteNode({ node, context })) {
      return
    }
    context.statusCenter.nodeStatus(node.id).process()
    const snapshot = context.snapshotCenter.create({ nodeID: node.id, data: node.data })
    let nextNodes = []
    try {
      const inputs = context.state.getNodeInputs(node)
      snapshot.update({ inputs })
      const result = await this.executor.execute({ node, inputs, runtime: context, container: null, snapshot })
      if (context.statusCenter.workflow.terminated) {
        return
      }
      const { outputs, branch } = result
      snapshot.update({ outputs, branch })
      context.state.setNodeOutputs({ node, outputs })
      context.state.addExecutedNode(node)
      context.statusCenter.nodeStatus(node.id).success()
      nextNodes = this.getNextNodes({ node, branch, context })
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred'
      snapshot.update({ error: errorMessage })
      context.messageCenter.error({ nodeID: node.id, message: errorMessage })
      context.statusCenter.nodeStatus(node.id).fail()
      throw e
    }
    await this.executeNext({ node, nextNodes, context })
  }
  async process(context) {
    const startNode = context.document.start
    context.statusCenter.workflow.process()
    try {
      await this.executeNode({ node: startNode, context })
      const outputs = context.ioCenter.outputs
      context.statusCenter.workflow.success()
      return outputs
    } catch {
      context.statusCenter.workflow.fail()
      return {}
    }
  }
  validate(params, context) {
    const { valid, errors } = this.validation.invoke(params)
    if (valid) {
      return true
    }
    errors?.forEach((message) => {
      context.messageCenter.error({ message })
    })
    context.statusCenter.workflow.fail()
    return false
  }
  canExecuteNode(params) {
    const { node, context } = params
    const prevNodes = node.prev
    if (prevNodes.length === 0) {
      return true
    }
    return prevNodes.every((prevNode) => context.state.isExecutedNode(prevNode))
  }
  getNextNodes(params) {
    const { node, branch, context } = params
    const allNextNodes = node.next
    if (!branch) {
      return allNextNodes
    }
    const targetPort = node.ports.outputs.find((port) => port.id === branch)
    if (!targetPort) {
      throw new Error(`Branch "${branch}" not found`)
    }
    const nextNodeIDs = new Set(targetPort.edges.map((edge) => edge.to.id))
    const nextNodes = allNextNodes.filter((nextNode) => nextNodeIDs.has(nextNode.id))
    const skipNodes = allNextNodes.filter((nextNode) => !nextNodeIDs.has(nextNode.id))
    const nextGroups = nextNodes.map((nextNode) => [nextNode, ...nextNode.successors])
    const skipGroups = skipNodes.map((skipNode) => [skipNode, ...skipNode.successors])
    const { uniqueToB: skippedNodes } = compareNodeGroups(nextGroups, skipGroups)
    skippedNodes.forEach((skipped) => {
      context.state.addExecutedNode(skipped)
    })
    return nextNodes
  }
  async executeNext(params) {
    const { context, node, nextNodes } = params
    const terminatingNodeTypes = [FlowGramNode.End, FlowGramNode.BlockEnd, FlowGramNode.Break, FlowGramNode.Continue]
    if (terminatingNodeTypes.includes(node.type)) {
      return
    }
    if (nextNodes.length === 0) {
      throw new Error(`Node "${node.id}" has no next nodes`)
    }
    await Promise.all(nextNodes.map((nextNode) => this.executeNode({ node: nextNode, context })))
  }
}
