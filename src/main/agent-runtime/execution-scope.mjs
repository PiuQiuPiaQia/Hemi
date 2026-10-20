import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export const withExecutionScope = (execution, signal, run) => scope.run({ execution, signal }, run);
export const currentExecutionScope = () => scope.getStore() ?? null;
