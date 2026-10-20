// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/infrastructure/utils/*。VENDOR-PATCH：uuid→crypto.randomUUID、
// lodash-es isNil/get/set→本地等价实现（去第三方运行时依赖）。

export const uuid = () => crypto.randomUUID()

// lodash isNil：value === null || value === undefined
export const isNil = (value) => value == null

// lodash get 的子集：path 为数组，中途 null/undefined 返回 undefined
export const getPath = (object, path) =>
  path.reduce((acc, key) => (acc == null ? undefined : acc[key]), object)

// lodash set 的子集：path 为数组，中途缺失建普通对象
export const setPath = (object, path, value) => {
  let cursor = object
  for (let i = 0; i < path.length - 1; i++) {
    if (cursor[path[i]] == null) cursor[path[i]] = {}
    cursor = cursor[path[i]]
  }
  cursor[path[path.length - 1]] = value
}

// src/infrastructure/utils/runtime-type.ts
import { WorkflowVariableType } from './constants.mjs'

export const WorkflowRuntimeType = {
  getWorkflowType(value) {
    if (value === null || value === undefined) {
      return WorkflowVariableType.Null
    }
    if (typeof value === 'string') {
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/
      if (iso8601Regex.test(value)) {
        const date = new Date(value)
        if (!isNaN(date.getTime())) {
          return WorkflowVariableType.DateTime
        }
      }
      return WorkflowVariableType.String
    }
    if (typeof value === 'boolean') {
      return WorkflowVariableType.Boolean
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return WorkflowVariableType.Integer
      }
      return WorkflowVariableType.Number
    }
    if (Array.isArray(value)) {
      return WorkflowVariableType.Array
    }
    if (typeof value === 'object') {
      return WorkflowVariableType.Object
    }
    return null
  },
  isMatchWorkflowType(value, type) {
    const workflowType = WorkflowRuntimeType.getWorkflowType(value)
    if (!workflowType) {
      return false
    }
    return workflowType === type
  },
  isTypeEqual(typeA, typeB) {
    if (
      (typeA === WorkflowVariableType.Number && typeB === WorkflowVariableType.Integer) ||
      (typeA === WorkflowVariableType.Integer && typeB === WorkflowVariableType.Number)
    ) {
      return true
    }
    return typeA === typeB
  },
  getArrayItemsType(types) {
    const expectedType = types[0]
    types.forEach((type) => {
      if (type !== expectedType) {
        throw new Error(`Array items type must be same, expect ${expectedType}, but got ${type}`)
      }
    })
    return expectedType
  },
}

// src/infrastructure/utils/traverse-nodes.ts
export function traverseNodes(startNode, getConnectedNodes) {
  const visited = new Set()
  const result = []
  const traverse = (node) => {
    for (const connectedNode of getConnectedNodes(node)) {
      if (!visited.has(connectedNode.id)) {
        visited.add(connectedNode.id)
        result.push(connectedNode)
        traverse(connectedNode)
      }
    }
  }
  traverse(startNode)
  return result
}

// src/infrastructure/utils/compare-node-groups.ts
export function compareNodeGroups(groupA, groupB) {
  const flatA = groupA.flat()
  const setA = new Map()
  flatA.forEach((node) => {
    setA.set(node.id, node)
  })
  const flatB = groupB.flat()
  const setB = new Map()
  flatB.forEach((node) => {
    setB.set(node.id, node)
  })
  const common = []
  const uniqueToA = []
  const uniqueToB = []
  setA.forEach((node, id) => {
    if (setB.has(id)) {
      common.push(node)
    } else {
      uniqueToA.push(node)
    }
  })
  setB.forEach((node, id) => {
    if (!setA.has(id)) {
      uniqueToB.push(node)
    }
  })
  return { common, uniqueToA, uniqueToB }
}
