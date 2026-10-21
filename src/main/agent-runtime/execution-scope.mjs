import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const withExecutionScope = (execution, signal, run, resources = {}) => scope.run({ execution, signal, ...resources }, run);
export const currentExecutionScope = () => scope.getStore() ?? null;
