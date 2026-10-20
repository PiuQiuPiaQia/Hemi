// Vendored from bytedance/flowgram.ai baseline 2ee4a9d2 (= runtime-js@1.0.16), MIT.
// 上游出处：src/infrastructure/utils/json-schema-validator.ts。

const ROOT_PATH = 'root'
const isRootPath = (path) => path === ROOT_PATH

const validateBoolean = (value, path) => {
  if (typeof value !== 'boolean') {
    return { result: false, errorMessage: `Expected boolean at ${path}, but got: ${typeof value}` }
  }
  return { result: true }
}

const validateString = (value, path) => {
  if (typeof value !== 'string') {
    return { result: false, errorMessage: `Expected string at ${path}, but got: ${typeof value}` }
  }
  return { result: true }
}

const validateInteger = (value, path) => {
  if (!Number.isInteger(value)) {
    return { result: false, errorMessage: `Expected integer at ${path}, but got: ${JSON.stringify(value)}` }
  }
  return { result: true }
}

const validateNumber = (value, path) => {
  if (typeof value !== 'number' || isNaN(value)) {
    return { result: false, errorMessage: `Expected number at ${path}, but got: ${JSON.stringify(value)}` }
  }
  return { result: true }
}

const validateObject = (value, schema, path) => {
  if (value === null || value === undefined) {
    return { result: false, errorMessage: `Expected object at ${path}, but got: ${value}` }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      result: false,
      errorMessage: `Expected object at ${path}, but got: ${Array.isArray(value) ? 'array' : typeof value}`,
    }
  }
  const objectValue = value
  if (schema.required && schema.required.length > 0) {
    for (const requiredProperty of schema.required) {
      if (!(requiredProperty in objectValue)) {
        return { result: false, errorMessage: `Missing required property "${requiredProperty}" at ${path}` }
      }
    }
  }
  if (schema.properties) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      if (propertyName in objectValue) {
        const propertyPath = isRootPath(path) ? propertyName : `${path}.${propertyName}`
        const propertyResult = validateValue(objectValue[propertyName], propertySchema, propertyPath)
        if (!propertyResult.result) {
          return propertyResult
        }
      }
    }
  }
  if (schema.additionalProperties) {
    const definedProperties = new Set(Object.keys(schema.properties || {}))
    for (const [propertyName, propertyValue] of Object.entries(objectValue)) {
      if (!definedProperties.has(propertyName)) {
        const propertyPath = isRootPath(path) ? propertyName : `${path}.${propertyName}`
        const propertyResult = validateValue(propertyValue, schema.additionalProperties, propertyPath)
        if (!propertyResult.result) {
          return propertyResult
        }
      }
    }
  }
  return { result: true }
}

const validateArray = (value, schema, path) => {
  if (!Array.isArray(value)) {
    return { result: false, errorMessage: `Expected array at ${path}, but got: ${typeof value}` }
  }
  if (schema.items) {
    for (const [index, item] of value.entries()) {
      const itemPath = `${path}[${index}]`
      const itemResult = validateValue(item, schema.items, itemPath)
      if (!itemResult.result) {
        return itemResult
      }
    }
  }
  return { result: true }
}

const validateMap = (value, schema, path) => {
  if (value === null || value === undefined) {
    return { result: false, errorMessage: `Expected map at ${path}, but got: ${value}` }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      result: false,
      errorMessage: `Expected map at ${path}, but got: ${Array.isArray(value) ? 'array' : typeof value}`,
    }
  }
  const mapValue = value
  if (schema.additionalProperties) {
    for (const [key, mapItemValue] of Object.entries(mapValue)) {
      const keyPath = isRootPath(path) ? key : `${path}.${key}`
      const keyResult = validateValue(mapItemValue, schema.additionalProperties, keyPath)
      if (!keyResult.result) {
        return keyResult
      }
    }
  }
  return { result: true }
}

const validateValue = (value, schema, path) => {
  if (schema.$ref) {
    return { result: true }
  }
  if (schema.enum && schema.enum.length > 0) {
    if (!schema.enum.includes(value)) {
      return {
        result: false,
        errorMessage: `Value at ${path} must be one of: ${schema.enum.join(', ')}, but got: ${JSON.stringify(value)}`,
      }
    }
  }
  switch (schema.type) {
    case 'boolean':
      return validateBoolean(value, path)
    case 'string':
      return validateString(value, path)
    case 'integer':
      return validateInteger(value, path)
    case 'number':
      return validateNumber(value, path)
    case 'object':
      return validateObject(value, schema, path)
    case 'array':
      return validateArray(value, schema, path)
    case 'map':
      return validateMap(value, schema, path)
    default:
      return { result: false, errorMessage: `Unknown type "${schema.type}" at ${path}` }
  }
}

export const JSONSchemaValidator = (params) => {
  const { schema, value } = params
  try {
    return validateValue(value, schema, ROOT_PATH)
  } catch (error) {
    return {
      result: false,
      errorMessage: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
