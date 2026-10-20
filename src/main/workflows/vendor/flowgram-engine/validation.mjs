// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/domain/validation/**（validators：schema-format／cycle-detection／
// edge-source-target-exist／start-end-node）。

import { FlowGramNode } from './constants.mjs'
import { JSONSchemaValidator } from './json-schema-validator.mjs'

// src/domain/validation/validators/schema-format.ts
const validateNodeFormat = (node, path) => {
  if (!node || typeof node !== 'object') {
    throw new Error(`${path} must be a valid object`)
  }
  if (typeof node.id !== 'string' || !node.id.trim()) {
    throw new Error(`${path}.id must be a non-empty string`)
  }
  if (typeof node.type !== 'string' || !node.type.trim()) {
    throw new Error(`${path}.type must be a non-empty string`)
  }
  if (!node.meta || typeof node.meta !== 'object') {
    throw new Error(`${path}.meta must be a valid object`)
  }
  if (!node.data || typeof node.data !== 'object') {
    throw new Error(`${path}.data must be a valid object`)
  }
  if (node.blocks !== undefined && !Array.isArray(node.blocks)) {
    throw new Error(`${path}.blocks must be an array if present`)
  }
  if (node.edges !== undefined && !Array.isArray(node.edges)) {
    throw new Error(`${path}.edges must be an array if present`)
  }
  if (node.data.inputs !== undefined && (typeof node.data.inputs !== 'object' || node.data.inputs === null)) {
    throw new Error(`${path}.data.inputs must be a valid object if present`)
  }
  if (node.data.outputs !== undefined && (typeof node.data.outputs !== 'object' || node.data.outputs === null)) {
    throw new Error(`${path}.data.outputs must be a valid object if present`)
  }
  if (node.data.inputsValues !== undefined && (typeof node.data.inputsValues !== 'object' || node.data.inputsValues === null)) {
    throw new Error(`${path}.data.inputsValues must be a valid object if present`)
  }
  if (node.data.title !== undefined && typeof node.data.title !== 'string') {
    throw new Error(`${path}.data.title must be a string if present`)
  }
}

const validateEdgeFormat = (edge, path) => {
  if (!edge || typeof edge !== 'object') {
    throw new Error(`${path} must be a valid object`)
  }
  if (typeof edge.sourceNodeID !== 'string' || !edge.sourceNodeID.trim()) {
    throw new Error(`${path}.sourceNodeID must be a non-empty string`)
  }
  if (typeof edge.targetNodeID !== 'string' || !edge.targetNodeID.trim()) {
    throw new Error(`${path}.targetNodeID must be a non-empty string`)
  }
  if (edge.sourcePortID !== undefined && typeof edge.sourcePortID !== 'string') {
    throw new Error(`${path}.sourcePortID must be a string if present`)
  }
  if (edge.targetPortID !== undefined && typeof edge.targetPortID !== 'string') {
    throw new Error(`${path}.targetPortID must be a string if present`)
  }
}

export const schemaFormat = (schema) => {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Workflow schema must be a valid object')
  }
  if (!Array.isArray(schema.nodes)) {
    throw new Error('Workflow schema must have a valid nodes array')
  }
  if (!Array.isArray(schema.edges)) {
    throw new Error('Workflow schema must have a valid edges array')
  }
  schema.nodes.forEach((node, index) => {
    validateNodeFormat(node, `nodes[${index}]`)
  })
  schema.edges.forEach((edge, index) => {
    validateEdgeFormat(edge, `edges[${index}]`)
  })
  schema.nodes.forEach((node, nodeIndex) => {
    if (node.blocks) {
      if (!Array.isArray(node.blocks)) {
        throw new Error(`Node nodes[${nodeIndex}].blocks must be an array`)
      }
      schemaFormat({ nodes: node.blocks, edges: node.edges || [] })
    }
  })
}

// src/domain/validation/validators/cycle-detection.ts
export const cycleDetection = (schema) => {
  const { nodes, edges } = schema
  const adjacencyList = new Map()
  const nodeIds = new Set(nodes.map((node) => node.id))
  nodeIds.forEach((nodeId) => {
    adjacencyList.set(nodeId, [])
  })
  edges.forEach((edge) => {
    const sourceList = adjacencyList.get(edge.sourceNodeID)
    if (sourceList) {
      sourceList.push(edge.targetNodeID)
    }
  })
  const Unvisited = 0
  const Visiting = 1
  const Visited = 2
  const nodeStatusMap = new Map()
  nodeIds.forEach((nodeId) => {
    nodeStatusMap.set(nodeId, Unvisited)
  })
  const detectCycleFromNode = (nodeId) => {
    nodeStatusMap.set(nodeId, Visiting)
    const neighbors = adjacencyList.get(nodeId) || []
    for (const neighbor of neighbors) {
      const neighborColor = nodeStatusMap.get(neighbor)
      if (neighborColor === Visiting) {
        return true
      }
      if (neighborColor === Unvisited && detectCycleFromNode(neighbor)) {
        return true
      }
    }
    nodeStatusMap.set(nodeId, Visited)
    return false
  }
  for (const nodeId of nodeIds) {
    if (nodeStatusMap.get(nodeId) === Unvisited) {
      if (detectCycleFromNode(nodeId)) {
        throw new Error('Workflow schema contains a cycle, which is not allowed')
      }
    }
  }
  nodes.forEach((node) => {
    if (node.blocks) {
      cycleDetection({ nodes: node.blocks, edges: node.edges ?? [] })
    }
  })
}

// src/domain/validation/validators/edge-source-target-exist.ts
export const edgeSourceTargetExist = (schema) => {
  const { nodes, edges } = schema
  const nodeSet = new Set(nodes.map((node) => node.id))
  edges.forEach((edge) => {
    if (!nodeSet.has(edge.sourceNodeID)) {
      throw new Error(`Workflow schema edge source node "${edge.sourceNodeID}" not exist`)
    }
    if (!nodeSet.has(edge.targetNodeID)) {
      throw new Error(`Workflow schema edge target node "${edge.targetNodeID}" not exist`)
    }
  })
  nodes.forEach((node) => {
    if (node.blocks) {
      edgeSourceTargetExist({ nodes: node.blocks, edges: node.edges ?? [] })
    }
  })
}

// src/domain/validation/validators/start-end-node.ts
const blockStartEndNode = (schema) => {
  if (!schema.nodes || !schema.nodes.length) {
    return
  }
  const blockStartNodes = schema.nodes.filter((node) => node.type === FlowGramNode.BlockStart)
  const blockEndNodes = schema.nodes.filter((node) => node.type === FlowGramNode.BlockEnd)
  if (blockStartNodes.length > 1) {
    throw new Error('Workflow block schema must have only one block-start node')
  }
  if (blockEndNodes.length > 1) {
    throw new Error('Workflow block schema must have only one block-end node')
  }
  schema.nodes.forEach((node) => {
    if (node.blocks) {
      blockStartEndNode({ nodes: node.blocks, edges: node.edges ?? [] })
    }
  })
}

export const startEndNode = (schema) => {
  const { startNodes, endNodes } = schema.nodes.reduce(
    (acc, node) => {
      if (node.type === FlowGramNode.Start) {
        acc.startNodes.push(node)
      } else if (node.type === FlowGramNode.End) {
        acc.endNodes.push(node)
      }
      return acc
    },
    { startNodes: [], endNodes: [] }
  )
  if (!startNodes.length && !endNodes.length) {
    throw new Error('Workflow schema must have a start node and an end node')
  }
  if (!startNodes.length) {
    throw new Error('Workflow schema must have a start node')
  }
  if (!endNodes.length) {
    throw new Error('Workflow schema must have an end node')
  }
  if (startNodes.length > 1) {
    throw new Error('Workflow schema must have only one start node')
  }
  if (endNodes.length > 1) {
    throw new Error('Workflow schema must have only one end node')
  }
  schema.nodes.forEach((node) => {
    if (node.blocks) {
      blockStartEndNode({ nodes: node.blocks, edges: node.edges ?? [] })
    }
  })
}

// src/domain/validation/index.ts
export class WorkflowRuntimeValidation {
  invoke(params) {
    const { schema, inputs } = params
    const schemaValidationResult = this.schema(schema)
    if (!schemaValidationResult.valid) {
      return schemaValidationResult
    }
    const inputsValidationResult = this.inputs(this.getWorkflowInputsDeclare(schema), inputs)
    if (!inputsValidationResult.valid) {
      return inputsValidationResult
    }
    return { valid: true }
  }
  schema(schema) {
    const errors = []
    const validations = [
      () => schemaFormat(schema),
      () => cycleDetection(schema),
      () => edgeSourceTargetExist(schema),
      () => startEndNode(schema),
    ]
    validations.forEach((validation) => {
      try {
        validation()
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    })
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
  }
  inputs(inputsSchema, inputs) {
    const { result, errorMessage } = JSONSchemaValidator({ schema: inputsSchema, value: inputs })
    if (!result) {
      return { valid: false, errors: [`JSON Schema validation failed: ${errorMessage}`] }
    }
    return { valid: true }
  }
  getWorkflowInputsDeclare(schema) {
    const startNode = schema.nodes.find((node) => node.type === FlowGramNode.Start)
    if (!startNode) {
      throw new Error('Workflow schema must have a start node')
    }
    return startNode.data.outputs
  }
}
