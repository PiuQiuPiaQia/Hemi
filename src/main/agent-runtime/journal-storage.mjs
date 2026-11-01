import { Worker } from 'node:worker_threads';
import path from 'node:path';

let worker, sequence = 0;
const requests = new Map();
export function inspectStorageForDiagnostics() { return {threadId:worker?.threadId,pending:[...requests.keys()]}; }
function request(operation, dir, payload = {}) {
  if (!worker) {
    const active = new Worker(new URL('./journal-storage-worker.mjs', import.meta.url), {execArgv:[]});
    worker = active;
    const fail = error => {
      if (worker !== active) return;
      worker = null;
      for (const pending of requests.values()) pending.reject(error);
      requests.clear();
    };
    active.on('message', ({ id, value, error }) => {
      const pending = requests.get(id);
      if (!pending) return;
      requests.delete(id);
      if (error) pending.reject(Object.assign(new Error(error.message), error));
      else pending.resolve(value);
      if (!requests.size) active.unref();
    });
    active.on('error', fail);
    active.on('exit', code => fail(new Error(`运行事实库工作线程已退出 (${code})`)));
  }
  worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    try { worker.postMessage({ id, operation, dir: path.resolve(dir), ...payload }); }
    catch (error) { requests.delete(id); if (!requests.size) worker.unref(); reject(error); }
  });
}

/** One shared IO worker; idle stores have no live timer/thread keeping Node alive. */
export function createJournalStorage(dir) {
  let revision;
  return {
    async load() { const value = await request('load', dir); revision = value.revision; return value.state; },
    async commit(changes) {
      const value = await request('commit', dir, { expectedRevision: revision, changes });
      revision = value.revision;
    },
  };
}

/** Read durable facts for diagnostics/tests without constructing an executable runtime. */
export async function readRunJournal(dir) { return (await request('load', dir)).state; }
export async function exportRunJournal(dir, target) { return request('export', dir, {target}); }
export function readJsonForUpdate(file) {return request('read-json',path.dirname(file),{file});}
export function prepareJsonWrite(file,record) {return request('prepare-json',path.dirname(file),{file,record});}
export function readJsonFields(file,fields) {return request('read-fields',path.dirname(file),{file,fields});}
