// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/domain/document/**（entity edge/node/port、flat-schema、create-store、document）。

import { FlowGramNode } from './constants.mjs'

// src/domain/document/entity/edge/index.ts
export class WorkflowRuntimeEdge {
  constructor(params) {
    const { id, from, to } = params
    this.id = id
    this.from = from
    this.to = to
  }
  get fromPort() {
    return this._fromPort
  }
  set fromPort(port) {
    this._fromPort = port
  }
  get toPort() {
    return this._toPort
  }
  set toPort(port) {
    this._toPort = port
  }
  static createID(schema) {
    const { sourceNodeID, sourcePortID, targetNodeID, targetPortID } = schema
    const sourcePart = sourcePortID ? `${sourceNodeID}:${sourcePortID}` : sourceNodeID
    const targetPart = targetPortID ? `${targetNodeID}:${targetPortID}` : targetNodeID
    return `${sourcePart}-${targetPart}`
  }
}

// src/domain/document/entity/node/index.ts
import { traverseNodes } from './utils.mjs'
import { WorkflowPortType } from './constants.mjs'

export class WorkflowRuntimeNode {
  constructor(params) {
    const { id, type, name, position, variable, data } = params
    this.id = id
    this.type = type
    this.name = name
    this.position = position
    this.declare = variable ?? {}
    this.data = data ?? {}
    this._parent = null
    this._children = []
    this._ports = []
    this._inputEdges = []
    this._outputEdges = []
    this._prev = []
    this._next = []
  }
  get ports() {
    const inputs = this._ports.filter((port) => port.type === WorkflowPortType.Input)
    const outputs = this._ports.filter((port) => port.type === WorkflowPortType.Output)
    return { inputs, outputs }
  }
  get edges() {
    return { inputs: this._inputEdges, outputs: this._outputEdges }
  }
  get parent() {
    return this._parent
  }
  set parent(parent) {
    this._parent = parent
  }
  get children() {
    return this._children
  }
  addChild(child) {
    this._children.push(child)
  }
  addPort(port) {
    this._ports.push(port)
  }
  addInputEdge(edge) {
    this._inputEdges.push(edge)
    this._prev.push(edge.from)
  }
  addOutputEdge(edge) {
    this._outputEdges.push(edge)
    this._next.push(edge.to)
  }
  get prev() {
    return this._prev
  }
  get next() {
    return this._next
  }
  get successors() {
    return traverseNodes(this, (node) => node.next)
  }
  get predecessors() {
    return traverseNodes(this, (node) => node.prev)
  }
  get isBranch() {
    return this.ports.outputs.length > 1
  }
}

// src/domain/document/entity/port/index.ts
export class WorkflowRuntimePort {
  constructor(params) {
    const { id, node } = params
    this.id = id
    this.node = node
    this.type = params.type
    this._edges = []
  }
  get edges() {
    return this._edges
  }
  addEdge(edge) {
    this._edges.push(edge)
  }
}

// src/domain/document/document/flat-schema.ts
const flatLayer = (data, nodeSchema) => {
  const { blocks, edges } = nodeSchema
  if (blocks) {
    data.flattenSchema.nodes.push(...blocks)
    const blockIDs = []
    blocks.forEach((block) => {
      blockIDs.push(block.id)
      if (block.blocks) {
        flatLayer(data, block)
      }
    })
    data.nodeBlocks.set(nodeSchema.id, blockIDs)
    delete nodeSchema.blocks
  }
  if (edges) {
    data.flattenSchema.edges.push(...edges)
    const edgeIDs = []
    edges.forEach((edge) => {
      edgeIDs.push(WorkflowRuntimeEdge.createID(edge))
    })
    data.nodeEdges.set(nodeSchema.id, edgeIDs)
    delete nodeSchema.edges
  }
}

export const flatSchema = (schema = { nodes: [], edges: [] }) => {
  const rootNodes = schema.nodes ?? []
  const rootEdges = schema.edges ?? []
  const data = {
    flattenSchema: { nodes: [], edges: [] },
    nodeBlocks: new Map(),
    nodeEdges: new Map(),
  }
  const root = {
    id: FlowGramNode.Root,
    type: FlowGramNode.Root,
    blocks: rootNodes,
    edges: rootEdges,
    meta: { position: { x: 0, y: 0 } },
    data: {},
  }
  flatLayer(data, root)
  return data
}

// src/domain/document/document/create-store.ts
const createNode = (store, params) => {
  const node = new WorkflowRuntimeNode(params)
  store.nodes.set(node.id, node)
  return node
}
const createEdge = (store, params) => {
  const edge = new WorkflowRuntimeEdge(params)
  store.edges.set(edge.id, edge)
  return edge
}
const getOrCreatePort = (store, params) => {
  const createdPort = store.ports.get(params.id)
  if (createdPort) {
    return createdPort
  }
  const port = new WorkflowRuntimePort(params)
  store.ports.set(port.id, port)
  return port
}

const createStore = ({ flattenSchema, nodeBlocks }) => {
  const { nodes, edges } = flattenSchema
  const store = { nodes: new Map(), edges: new Map(), ports: new Map() }
  createNode(store, { id: FlowGramNode.Root, type: FlowGramNode.Root, name: FlowGramNode.Root, position: { x: 0, y: 0 } })
  nodes.forEach((nodeSchema) => {
    const id = nodeSchema.id
    const type = nodeSchema.type
    const { title = `${type}-${id}-untitled`, inputsValues, inputs, outputs, ...data } = nodeSchema.data ?? {}
    createNode(store, {
      id,
      type,
      name: title,
      position: nodeSchema.meta.position,
      variable: { inputsValues, inputs, outputs },
      data,
    })
  })
  nodeBlocks.forEach((blockIDs, parentID) => {
    const parent = store.nodes.get(parentID)
    const children = blockIDs.map((id) => store.nodes.get(id)).filter(Boolean)
    children.forEach((child) => {
      child.parent = parent
      parent.addChild(child)
    })
  })
  edges.forEach((edgeSchema) => {
    const id = WorkflowRuntimeEdge.createID(edgeSchema)
    const { sourceNodeID, targetNodeID, sourcePortID = 'defaultOutput', targetPortID = 'defaultInput' } = edgeSchema
    const from = store.nodes.get(sourceNodeID)
    const to = store.nodes.get(targetNodeID)
    if (!from || !to) {
      throw new Error(`Invalid edge schema ID: ${id}, from: ${sourceNodeID}, to: ${targetNodeID}`)
    }
    const edge = createEdge(store, { id, from, to })
    const fromPort = getOrCreatePort(store, { node: from, id: sourcePortID, type: WorkflowPortType.Output })
    fromPort.addEdge(edge)
    edge.fromPort = fromPort
    from.addPort(fromPort)
    from.addOutputEdge(edge)
    const toPort = getOrCreatePort(store, { node: to, id: targetPortID, type: WorkflowPortType.Input })
    toPort.addEdge(edge)
    edge.toPort = toPort
    to.addPort(toPort)
    to.addInputEdge(edge)
  })
  return store
}

// src/domain/document/document/index.ts
export class WorkflowRuntimeDocument {
  constructor() {
    this.id = crypto.randomUUID()
  }
  get root() {
    const rootNode = this.getNode(FlowGramNode.Root)
    if (!rootNode) {
      throw new Error('Root node not found')
    }
    return rootNode
  }
  get start() {
    const startNode = this.nodes.find((n) => n.type === FlowGramNode.Start)
    if (!startNode) {
      throw new Error('Start node not found')
    }
    return startNode
  }
  get end() {
    const endNode = this.nodes.find((n) => n.type === FlowGramNode.End)
    if (!endNode) {
      throw new Error('End node not found')
    }
    return endNode
  }
  getNode(id) {
    return this.store.nodes.get(id) ?? null
  }
  getEdge(id) {
    return this.store.edges.get(id) ?? null
  }
  get nodes() {
    return Array.from(this.store.nodes.values())
  }
  get edges() {
    return Array.from(this.store.edges.values())
  }
  init(schema) {
    const flattenSchema = flatSchema(schema)
    this.store = createStore(flattenSchema)
  }
  dispose() {
    this.store.edges.clear()
    this.store.nodes.clear()
    this.store.ports.clear()
  }
}
