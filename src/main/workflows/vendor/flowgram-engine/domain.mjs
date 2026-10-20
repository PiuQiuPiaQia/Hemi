// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/domain/{cache,io-center,message,message-center,snapshot,status,variable,state,report}/**。
// VENDOR-PATCH：uuid→crypto.randomUUID、lodash-es get/set→getPath/setPath（见 utils.mjs）。

import { WorkflowMessageType, WorkflowStatus, WorkflowVariableType } from './constants.mjs'
import { uuid, isNil, getPath, setPath, WorkflowRuntimeType } from './utils.mjs'

// src/domain/cache/index.ts
export class WorkflowRuntimeCache {
  init() {
    this.map = new Map()
  }
  dispose() {
    this.map.clear()
  }
  get(key) {
    return this.map.get(key)
  }
  set(key, value) {
    this.map.set(key, value)
    return this
  }
  delete(key) {
    return this.map.delete(key)
  }
  has(key) {
    return this.map.has(key)
  }
}

// src/domain/io-center/index.ts
export class WorkflowRuntimeIOCenter {
  init(inputs) {
    this.setInputs(inputs)
  }
  dispose() {}
  get inputs() {
    return this._inputs ?? {}
  }
  get outputs() {
    return this._outputs ?? {}
  }
  setInputs(inputs) {
    this._inputs = inputs
  }
  setOutputs(outputs) {
    this._outputs = outputs
  }
}

// src/domain/message/message-value-object/index.ts
export const WorkflowRuntimeMessage = {
  create(params) {
    const message = { id: uuid(), ...params }
    if (!params.timestamp) {
      message.timestamp = Date.now()
    }
    return message
  },
}

// src/domain/message/message-center/index.ts
export class WorkflowRuntimeMessageCenter {
  init() {
    this.messages = {
      [WorkflowMessageType.Log]: [],
      [WorkflowMessageType.Info]: [],
      [WorkflowMessageType.Debug]: [],
      [WorkflowMessageType.Error]: [],
      [WorkflowMessageType.Warn]: [],
    }
  }
  dispose() {}
  log(data) {
    const message = WorkflowRuntimeMessage.create({ type: WorkflowMessageType.Log, ...data })
    this.messages[WorkflowMessageType.Log].push(message)
    return message
  }
  info(data) {
    const message = WorkflowRuntimeMessage.create({ type: WorkflowMessageType.Info, ...data })
    this.messages[WorkflowMessageType.Info].push(message)
    return message
  }
  debug(data) {
    const message = WorkflowRuntimeMessage.create({ type: WorkflowMessageType.Debug, ...data })
    this.messages[WorkflowMessageType.Debug].push(message)
    return message
  }
  error(data) {
    const message = WorkflowRuntimeMessage.create({ type: WorkflowMessageType.Error, ...data })
    this.messages[WorkflowMessageType.Error].push(message)
    return message
  }
  warn(data) {
    const message = WorkflowRuntimeMessage.create({ type: WorkflowMessageType.Warn, ...data })
    this.messages[WorkflowMessageType.Warn].push(message)
    return message
  }
  export() {
    return {
      [WorkflowMessageType.Log]: this.messages[WorkflowMessageType.Log].slice(),
      [WorkflowMessageType.Info]: this.messages[WorkflowMessageType.Info].slice(),
      [WorkflowMessageType.Debug]: this.messages[WorkflowMessageType.Debug].slice(),
      [WorkflowMessageType.Error]: this.messages[WorkflowMessageType.Error].slice(),
      [WorkflowMessageType.Warn]: this.messages[WorkflowMessageType.Warn].slice(),
    }
  }
}

// src/domain/snapshot/snapshot-entity/index.ts
export class WorkflowRuntimeSnapshot {
  constructor(data) {
    this.id = uuid()
    this.data = data
  }
  update(data) {
    Object.assign(this.data, data)
  }
  validate() {
    const required = ['nodeID', 'inputs', 'outputs', 'data']
    return required.every((key) => this.data[key] !== undefined)
  }
  export() {
    return { id: this.id, ...this.data }
  }
  static create(params) {
    return new WorkflowRuntimeSnapshot(params)
  }
}

// src/domain/snapshot/snapshot-center/index.ts
export class WorkflowRuntimeSnapshotCenter {
  constructor() {
    this.id = uuid()
  }
  create(snapshotData) {
    const snapshot = WorkflowRuntimeSnapshot.create(snapshotData)
    this.snapshots.push(snapshot)
    return snapshot
  }
  init() {
    this.snapshots = []
  }
  dispose() {}
  exportAll() {
    return this.snapshots.slice().map((snapshot) => snapshot.export())
  }
  export() {
    const result = {}
    this.exportAll().forEach((snapshot) => {
      if (result[snapshot.nodeID]) {
        result[snapshot.nodeID].push(snapshot)
      } else {
        result[snapshot.nodeID] = [snapshot]
      }
    })
    return result
  }
}

// src/domain/status/status-entity/index.ts
export class WorkflowRuntimeStatus {
  constructor() {
    this.id = uuid()
    this._status = WorkflowStatus.Pending
  }
  get status() {
    return this._status
  }
  get terminated() {
    return [WorkflowStatus.Succeeded, WorkflowStatus.Failed, WorkflowStatus.Cancelled].includes(this.status)
  }
  get startTime() {
    return this._startTime
  }
  get endTime() {
    return this._endTime
  }
  get timeCost() {
    if (!this.startTime) {
      return 0
    }
    if (this.endTime) {
      return this.endTime - this.startTime
    }
    return Date.now() - this.startTime
  }
  process() {
    this._status = WorkflowStatus.Processing
    this._startTime = Date.now()
    this._endTime = undefined
  }
  success() {
    if (this.terminated) {
      return
    }
    this._status = WorkflowStatus.Succeeded
    this._endTime = Date.now()
  }
  fail() {
    if (this.terminated) {
      return
    }
    this._status = WorkflowStatus.Failed
    this._endTime = Date.now()
  }
  cancel() {
    if (this.terminated) {
      return
    }
    this._status = WorkflowStatus.Cancelled
    this._endTime = Date.now()
  }
  export() {
    return {
      status: this.status,
      terminated: this.terminated,
      startTime: this.startTime,
      endTime: this.endTime,
      timeCost: this.timeCost,
    }
  }
  static create() {
    return new WorkflowRuntimeStatus()
  }
}

// src/domain/status/status-center/index.ts
export class WorkflowRuntimeStatusCenter {
  init() {
    this._workflowStatus = WorkflowRuntimeStatus.create()
    this._nodeStatus = new Map()
  }
  dispose() {}
  get workflow() {
    return this._workflowStatus
  }
  get workflowStatus() {
    return this._workflowStatus
  }
  nodeStatus(nodeID) {
    if (!this._nodeStatus.has(nodeID)) {
      this._nodeStatus.set(nodeID, WorkflowRuntimeStatus.create())
    }
    return this._nodeStatus.get(nodeID)
  }
  getStatusNodeIDs(status) {
    return Array.from(this._nodeStatus.entries())
      .filter(([, nodeStatus]) => nodeStatus.status === status)
      .map(([nodeID]) => nodeID)
  }
  exportNodeStatus() {
    return Object.fromEntries(
      Array.from(this._nodeStatus.entries()).map(([nodeID, status]) => [nodeID, status.export()])
    )
  }
}

// src/domain/variable/variable-value-object/index.ts
export const WorkflowRuntimeVariable = {
  create(params) {
    return { id: uuid(), ...params }
  },
}

// src/domain/variable/variable-store/index.ts
export class WorkflowRuntimeVariableStore {
  constructor() {
    this.id = uuid()
  }
  init() {
    this.store = new Map()
  }
  dispose() {
    this.store.clear()
  }
  setParent(parent) {
    this.parent = parent
  }
  globalGet(nodeID) {
    const store = this.store.get(nodeID)
    if (!store && this.parent) {
      return this.parent.globalGet(nodeID)
    }
    return store
  }
  setVariable(params) {
    const { nodeID, key, value, type, itemsType } = params
    if (!this.store.has(nodeID)) {
      this.store.set(nodeID, new Map())
    }
    const nodeStore = this.store.get(nodeID)
    const variable = WorkflowRuntimeVariable.create({ nodeID, key, value, type, itemsType })
    nodeStore.set(key, variable)
  }
  setValue(params) {
    const { nodeID, variableKey, variablePath, value } = params
    if (!this.store.has(nodeID)) {
      this.store.set(nodeID, new Map())
    }
    const nodeStore = this.store.get(nodeID)
    if (!nodeStore.has(variableKey)) {
      const variable = WorkflowRuntimeVariable.create({
        nodeID,
        key: variableKey,
        value: {},
        type: WorkflowVariableType.Object,
      })
      nodeStore.set(variableKey, variable)
    }
    const variable = nodeStore.get(variableKey)
    if (!variablePath) {
      variable.value = value
      return
    }
    setPath(variable.value, variablePath, value)
  }
  getValue(params) {
    const { nodeID, variableKey, variablePath } = params
    const variable = this.globalGet(nodeID)?.get(variableKey)
    if (!variable) {
      return null
    }
    if (!variablePath || variablePath.length === 0) {
      return { value: variable.value, type: variable.type, itemsType: variable.itemsType }
    }
    const value = getPath(variable.value, variablePath)
    const type = WorkflowRuntimeType.getWorkflowType(value)
    if (!type) {
      return null
    }
    if (type === WorkflowVariableType.Array && Array.isArray(value)) {
      const itemsType = WorkflowRuntimeType.getWorkflowType(value[0])
      if (!itemsType) {
        return null
      }
      return { value, type, itemsType }
    }
    return { value, type }
  }
}

// src/domain/state/index.ts
export class WorkflowRuntimeState {
  constructor(variableStore) {
    this.variableStore = variableStore
    this.id = uuid()
  }
  init(schema) {
    this.setGlobalVariable(schema?.globalVariable)
    this.executedNodes = new Set()
  }
  dispose() {
    this.executedNodes.clear()
  }
  getNodeInputs(node) {
    const inputsDeclare = node.declare.inputs
    const inputsValues = node.declare.inputsValues
    return this.parseInputs({ values: inputsValues, declare: inputsDeclare })
  }
  setNodeOutputs(params) {
    const { node, outputs } = params
    const outputsDeclare = node.declare.outputs
    if (outputsDeclare?.type !== 'object' || !outputsDeclare.properties) {
      return
    }
    Object.entries(outputsDeclare.properties).forEach(([key, typeInfo]) => {
      if (!key || !typeInfo) {
        return
      }
      const type = typeInfo.type
      const itemsType = typeInfo.items?.type
      const defaultValue = this.parseJSONContent(typeInfo.default, type)
      const value = outputs[key] ?? defaultValue
      this.variableStore.setVariable({ nodeID: node.id, key, value, type, itemsType })
    })
  }
  parseInputs(params) {
    const { values, declare } = params
    if (!declare || !values) {
      return {}
    }
    return Object.entries(values).reduce((prev, [key, flowValue]) => {
      const typeInfo = declare.properties?.[key]
      if (!typeInfo) {
        return prev
      }
      const declareType = typeInfo.type
      const result = this.parseFlowValue({ flowValue, declareType })
      if (!result) {
        return prev
      }
      const { value, type } = result
      if (!WorkflowRuntimeType.isTypeEqual(type, declareType)) {
        return prev
      }
      prev[key] = value
      return prev
    }, {})
  }
  parseRef(ref) {
    if (ref?.type !== 'ref') {
      throw new Error(`Invalid ref value: ${ref}`)
    }
    if (!ref.content || ref.content.length < 2) {
      return null
    }
    const [nodeID, variableKey, ...variablePath] = ref.content
    return this.variableStore.getValue({ nodeID, variableKey, variablePath }) ?? null
  }
  parseTemplate(template) {
    if (template?.type !== 'template') {
      throw new Error(`Invalid template value: ${template}`)
    }
    if (!template.content) {
      return null
    }
    const parsedValue = template.content.replace(/\{\{([^\}]+)\}\}/g, (match, pattern) => {
      const ref = pattern.trim().split('.')
      const variable = this.parseRef({ type: 'ref', content: ref })
      if (!variable) {
        return ''
      }
      return variable.value
    })
    return { type: WorkflowVariableType.String, value: parsedValue }
  }
  parseFlowValue(params) {
    const { flowValue, declareType } = params
    if (!flowValue?.type) {
      throw new Error(`Invalid flow value type: ${flowValue.type}`)
    }
    if (flowValue.type === 'constant') {
      const value = this.parseJSONContent(flowValue.content, declareType)
      const type = declareType ?? WorkflowRuntimeType.getWorkflowType(value)
      if (isNil(value) || !type) {
        return null
      }
      return { value, type }
    }
    if (flowValue.type === 'ref') {
      return this.parseRef(flowValue)
    }
    if (flowValue.type === 'template') {
      return this.parseTemplate(flowValue)
    }
    throw new Error(`Unknown flow value type: ${flowValue.type}`)
  }
  isExecutedNode(node) {
    return this.executedNodes.has(node.id)
  }
  addExecutedNode(node) {
    this.executedNodes.add(node.id)
  }
  parseJSONContent(jsonContent, declareType) {
    const JSONTypes = [WorkflowVariableType.Object, WorkflowVariableType.Array, WorkflowVariableType.Map]
    if (declareType && JSONTypes.includes(declareType) && typeof jsonContent === 'string') {
      try {
        return JSON.parse(jsonContent)
      } catch {
        return jsonContent
      }
    }
    return jsonContent
  }
  setGlobalVariable(globalVariableDeclare) {
    if (globalVariableDeclare?.type !== 'object' || !globalVariableDeclare.properties) {
      return
    }
    Object.entries(globalVariableDeclare.properties).forEach(([key, typeInfo]) => {
      if (!key || !typeInfo) {
        return
      }
      const type = typeInfo.type
      const itemsType = typeInfo.items?.type
      const defaultValue = this.parseJSONContent(typeInfo.default, type)
      this.variableStore.setVariable({ nodeID: 'global', key, value: defaultValue, type, itemsType })
    })
  }
}

// src/domain/report/report-value-object/index.ts
export const WorkflowRuntimeReport = {
  create(params) {
    return { id: uuid(), ...params }
  },
}

// src/domain/report/reporter/index.ts
export class WorkflowRuntimeReporter {
  constructor(ioCenter, snapshotCenter, statusCenter, messageCenter) {
    this.ioCenter = ioCenter
    this.snapshotCenter = snapshotCenter
    this.statusCenter = statusCenter
    this.messageCenter = messageCenter
  }
  init() {}
  dispose() {}
  export() {
    return WorkflowRuntimeReport.create({
      inputs: this.ioCenter.inputs,
      outputs: this.ioCenter.outputs,
      workflowStatus: this.statusCenter.workflow.export(),
      reports: this.nodeReports(),
      messages: this.messageCenter.export(),
    })
  }
  nodeReports() {
    const reports = {}
    const statuses = this.statusCenter.exportNodeStatus()
    const snapshots = this.snapshotCenter.export()
    Object.keys(statuses).forEach((nodeID) => {
      reports[nodeID] = { id: nodeID, ...statuses[nodeID], snapshots: snapshots[nodeID] || [] }
    })
    return reports
  }
}
