export const JOURNAL_TABLES = ['roots', 'dispatches', 'tasks', 'inbox', 'requests', 'observations', 'processes'];
const drafts = new WeakMap();

/** Reads share immutable records; only explicitly edited records are copied. */
export function createJournalDraft(state) {
  const changes = {};
  const draft = { version: state.version };
  for (const table of JOURNAL_TABLES) {
    const changed = {};
    draft[table] = new Proxy(state[table], {
      get: (target, id) => Object.hasOwn(changed, id) ? changed[id] : target[id],
      set(_target, id, value) {
        Object.defineProperty(changed, id, { value:structuredClone(value), writable: true, enumerable: true, configurable: true });
        changes[table] = changed;
        return true;
      },
      ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(changed)])],
      getOwnPropertyDescriptor: (target, id) => Object.getOwnPropertyDescriptor(changed, id) ?? Object.getOwnPropertyDescriptor(target, id),
    });
  }
  drafts.set(draft, changes);
  return { draft, changes };
}
export function editJournalRecord(draft, table, id) {
  const changes = drafts.get(draft);
  if (!Object.hasOwn(changes[table] ?? {}, id) && draft[table][id] != null) draft[table][id] = structuredClone(draft[table][id]);
  return draft[table][id];
}
export function applyJournalChanges(state, changes) {
  for (const [table, records] of Object.entries(changes)) for (const [id, record] of Object.entries(records)) {
    Object.defineProperty(state[table], id, { value: record, writable: true, enumerable: true, configurable: true });
  }
}
