// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/nodes/{start,end,condition}/**（含 rules.ts 与 handlers/*）。
// VENDOR-PATCH：条件 handlers 由上游每类型一文件合并为本文件内等价函数；llm/code/http/loop
// 系节点不 vendor（vendoring 方案：剔 langchain/quickjs 依赖）。

import { ConditionOperator, FlowGramNode, WorkflowVariableType } from './constants.mjs'
import { isNil, WorkflowRuntimeType } from './utils.mjs'

// src/nodes/start/index.ts
export class StartExecutor {
  constructor() {
    this.type = FlowGramNode.Start
  }
  async execute(context) {
    return { outputs: context.runtime.ioCenter.inputs }
  }
}

// src/nodes/end/index.ts
export class EndExecutor {
  constructor() {
    this.type = FlowGramNode.End
  }
  async execute(context) {
    context.runtime.ioCenter.setOutputs(context.inputs)
    return { outputs: context.inputs }
  }
}

// src/nodes/condition/rules.ts
export const conditionRules = {
  [WorkflowVariableType.String]: {
    [ConditionOperator.EQ]: WorkflowVariableType.String,
    [ConditionOperator.NEQ]: WorkflowVariableType.String,
    [ConditionOperator.CONTAINS]: WorkflowVariableType.String,
    [ConditionOperator.NOT_CONTAINS]: WorkflowVariableType.String,
    [ConditionOperator.IN]: WorkflowVariableType.Array,
    [ConditionOperator.NIN]: WorkflowVariableType.Array,
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Number]: {
    [ConditionOperator.EQ]: WorkflowVariableType.Number,
    [ConditionOperator.NEQ]: WorkflowVariableType.Number,
    [ConditionOperator.GT]: WorkflowVariableType.Number,
    [ConditionOperator.GTE]: WorkflowVariableType.Number,
    [ConditionOperator.LT]: WorkflowVariableType.Number,
    [ConditionOperator.LTE]: WorkflowVariableType.Number,
    [ConditionOperator.IN]: WorkflowVariableType.Array,
    [ConditionOperator.NIN]: WorkflowVariableType.Array,
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Integer]: {
    [ConditionOperator.EQ]: WorkflowVariableType.Integer,
    [ConditionOperator.NEQ]: WorkflowVariableType.Integer,
    [ConditionOperator.GT]: WorkflowVariableType.Integer,
    [ConditionOperator.GTE]: WorkflowVariableType.Integer,
    [ConditionOperator.LT]: WorkflowVariableType.Integer,
    [ConditionOperator.LTE]: WorkflowVariableType.Integer,
    [ConditionOperator.IN]: WorkflowVariableType.Array,
    [ConditionOperator.NIN]: WorkflowVariableType.Array,
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Boolean]: {
    [ConditionOperator.EQ]: WorkflowVariableType.Boolean,
    [ConditionOperator.NEQ]: WorkflowVariableType.Boolean,
    [ConditionOperator.IS_TRUE]: WorkflowVariableType.Null,
    [ConditionOperator.IS_FALSE]: WorkflowVariableType.Null,
    [ConditionOperator.IN]: WorkflowVariableType.Array,
    [ConditionOperator.NIN]: WorkflowVariableType.Array,
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Object]: {
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Map]: {
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.DateTime]: {
    [ConditionOperator.EQ]: WorkflowVariableType.DateTime,
    [ConditionOperator.NEQ]: WorkflowVariableType.DateTime,
    [ConditionOperator.GT]: WorkflowVariableType.DateTime,
    [ConditionOperator.GTE]: WorkflowVariableType.DateTime,
    [ConditionOperator.LT]: WorkflowVariableType.DateTime,
    [ConditionOperator.LTE]: WorkflowVariableType.DateTime,
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Array]: {
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
  [WorkflowVariableType.Null]: {
    [ConditionOperator.EQ]: WorkflowVariableType.Null,
    [ConditionOperator.IS_EMPTY]: WorkflowVariableType.Null,
    [ConditionOperator.IS_NOT_EMPTY]: WorkflowVariableType.Null,
  },
}

// src/nodes/condition/handlers/string.ts
const conditionStringHandler = (condition) => {
  const { operator, leftValue } = condition
  const rightValue = condition.rightValue
  if (operator === ConditionOperator.EQ) return leftValue === rightValue
  if (operator === ConditionOperator.NEQ) return leftValue !== rightValue
  if (operator === ConditionOperator.CONTAINS) return leftValue.includes(rightValue)
  if (operator === ConditionOperator.NOT_CONTAINS) return !leftValue.includes(rightValue)
  if (operator === ConditionOperator.IN) return rightValue.includes(leftValue)
  if (operator === ConditionOperator.NIN) return !rightValue.includes(leftValue)
  if (operator === ConditionOperator.IS_EMPTY) return isNil(leftValue)
  if (operator === ConditionOperator.IS_NOT_EMPTY) return !isNil(leftValue)
  return false
}

// src/nodes/condition/handlers/number.ts（上游 Integer 复用同一 handler）
const conditionNumberHandler = (condition) => {
  const { operator, leftValue } = condition
  const rightValue = condition.rightValue
  if (operator === ConditionOperator.EQ) return leftValue === rightValue
  if (operator === ConditionOperator.NEQ) return leftValue !== rightValue
  if (operator === ConditionOperator.GT) return leftValue > rightValue
  if (operator === ConditionOperator.GTE) return leftValue >= rightValue
  if (operator === ConditionOperator.LT) return leftValue < rightValue
  if (operator === ConditionOperator.LTE) return leftValue <= rightValue
  if (operator === ConditionOperator.IN) return rightValue.includes(leftValue)
  if (operator === ConditionOperator.NIN) return !rightValue.includes(leftValue)
  if (operator === ConditionOperator.IS_EMPTY) return isNil(leftValue)
  if (operator === ConditionOperator.IS_NOT_EMPTY) return !isNil(leftValue)
  return false
}

// src/nodes/condition/handlers/boolean.ts
const conditionBooleanHandler = (condition) => {
  const { operator, leftValue } = condition
  const rightValue = condition.rightValue
  if (operator === ConditionOperator.EQ) return leftValue === rightValue
  if (operator === ConditionOperator.NEQ) return leftValue !== rightValue
  if (operator === ConditionOperator.IS_TRUE) return leftValue === true
  if (operator === ConditionOperator.IS_FALSE) return leftValue === false
  if (operator === ConditionOperator.IN) return rightValue.includes(leftValue)
  if (operator === ConditionOperator.NIN) return !rightValue.includes(leftValue)
  if (operator === ConditionOperator.IS_EMPTY) return isNil(leftValue)
  if (operator === ConditionOperator.IS_NOT_EMPTY) return !isNil(leftValue)
  return false
}

// src/nodes/condition/handlers/object.ts ＆ map.ts ＆ array.ts（同一形状）
const conditionEmptyCheckHandler = (condition) => {
  const { operator, leftValue } = condition
  if (operator === ConditionOperator.IS_EMPTY) return isNil(leftValue)
  if (operator === ConditionOperator.IS_NOT_EMPTY) return !isNil(leftValue)
  return false
}

// src/nodes/condition/handlers/datetime.ts
const parseDateTime = (value) => (value instanceof Date ? value : new Date(value))
const conditionDateTimeHandler = (condition) => {
  const { operator, leftValue } = condition
  if (operator === ConditionOperator.IS_EMPTY) return isNil(leftValue)
  if (operator === ConditionOperator.IS_NOT_EMPTY) return !isNil(leftValue)
  const leftTime = parseDateTime(leftValue).getTime()
  const rightTime = parseDateTime(condition.rightValue).getTime()
  if (operator === ConditionOperator.EQ) return leftTime === rightTime
  if (operator === ConditionOperator.NEQ) return leftTime !== rightTime
  if (operator === ConditionOperator.GT) return leftTime > rightTime
  if (operator === ConditionOperator.GTE) return leftTime >= rightTime
  if (operator === ConditionOperator.LT) return leftTime < rightTime
  if (operator === ConditionOperator.LTE) return leftTime <= rightTime
  return false
}

// src/nodes/condition/handlers/null.ts
const conditionNullHandler = (condition) => {
  const { operator, leftValue } = condition
  if (operator === ConditionOperator.EQ) return isNil(leftValue) && isNil(condition.rightValue)
  if (operator === ConditionOperator.IS_EMPTY) return isNil(leftValue)
  if (operator === ConditionOperator.IS_NOT_EMPTY) return !isNil(leftValue)
  return false
}

// src/nodes/condition/handlers/index.ts
export const conditionHandlers = {
  [WorkflowVariableType.String]: conditionStringHandler,
  [WorkflowVariableType.Number]: conditionNumberHandler,
  [WorkflowVariableType.Integer]: conditionNumberHandler,
  [WorkflowVariableType.Boolean]: conditionBooleanHandler,
  [WorkflowVariableType.Object]: conditionEmptyCheckHandler,
  [WorkflowVariableType.Map]: conditionEmptyCheckHandler,
  [WorkflowVariableType.Array]: conditionEmptyCheckHandler,
  [WorkflowVariableType.DateTime]: conditionDateTimeHandler,
  [WorkflowVariableType.Null]: conditionNullHandler,
}

// src/nodes/condition/index.ts
export class ConditionExecutor {
  constructor() {
    this.type = FlowGramNode.Condition
  }
  async execute(context) {
    const conditions = context.node.data?.conditions
    if (!conditions) {
      return { outputs: {} }
    }
    const parsedConditions = conditions
      .map((item) => this.parseCondition(item, context))
      .filter((item) => this.checkCondition(item))
    const activatedCondition = parsedConditions.find((item) => this.handleCondition(item))
    if (!activatedCondition) {
      return { outputs: {}, branch: 'else' }
    }
    return { outputs: {}, branch: activatedCondition.key }
  }
  parseCondition(item, context) {
    const { key, value } = item
    const { left, operator, right } = value
    const parsedLeft = context.runtime.state.parseRef(left)
    const leftValue = parsedLeft?.value ?? null
    const leftType = parsedLeft?.type ?? WorkflowVariableType.Null
    const expectedRightType = this.getRuleType({ leftType, operator })
    const parsedRight = Boolean(right)
      ? context.runtime.state.parseFlowValue({ flowValue: right, declareType: expectedRightType })
      : null
    const rightValue = parsedRight?.value ?? null
    const rightType = parsedRight?.type ?? WorkflowVariableType.Null
    return { key, leftValue, leftType, rightValue, rightType, operator }
  }
  checkCondition(condition) {
    const rule = conditionRules[condition.leftType]
    if (isNil(rule)) {
      throw new Error(`Condition left type "${condition.leftType}" is not supported`)
    }
    const ruleType = rule[condition.operator]
    if (isNil(ruleType)) {
      throw new Error(`Condition left type "${condition.leftType}" has no operator "${condition.operator}"`)
    }
    if (!WorkflowRuntimeType.isTypeEqual(ruleType, condition.rightType)) {
      return false
    }
    return true
  }
  handleCondition(condition) {
    const handler = conditionHandlers[condition.leftType]
    if (!handler) {
      throw new Error(`Condition left type ${condition.leftType} is not supported`)
    }
    return handler(condition)
  }
  getRuleType(params) {
    const { leftType, operator } = params
    const rule = conditionRules[leftType]
    if (isNil(rule)) {
      return WorkflowVariableType.Null
    }
    const ruleType = rule[operator]
    if (isNil(ruleType)) {
      return WorkflowVariableType.Null
    }
    return ruleType
  }
}
