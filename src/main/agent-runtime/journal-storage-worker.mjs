import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const tables = ['roots', 'dispatches', 'tasks', 'inbox', 'requests', 'observations', 'processes'];
const empty = () => Object.fromEntries([['version', 2], ...tables.map(table => [table, {}])]);
function validate(state) {
  state.observations ??= {};
  state.processes ??= {};
  if (state.version !== 2 || tables.some(table => !state[table] || typeof state[table] !== 'object' || Array.isArray(state[table]))) {
    throw new Error('运行事实库版本或结构损坏');
  }
  return state;
}
function initialize(dir, file) {
  fs.mkdirSync(dir, { recursive: true });
  let state = empty();
  try { state = validate(JSON.parse(fs.readFileSync(path.join(dir, 'run-journal.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`运行事实库读取失败：${error.message}`); }
  const tmp = `${file}.${randomUUID()}.tmp`;
  let db;
  try {
    db = new DatabaseSync(tmp);
    fs.chmodSync(tmp, 0o600);
    db.exec('CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL); CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id)); BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO records(kind,id,value) VALUES (?,?,?)');
    for (const table of tables) for (const [id, record] of Object.entries(state[table])) insert.run(table, id, JSON.stringify(record));
    db.exec('INSERT INTO metadata VALUES (1,1,0); COMMIT');
    db.close(); db = null;
    // Keep the legacy JSON unchanged. A failed import never installs a partial DB.
    fs.renameSync(tmp, file);
  } finally {
    db?.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(tmp + suffix); } catch {} }
  }
}
function open(dir) {
  const file = path.join(dir, 'run-journal.sqlite');
  try { fs.statSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; initialize(dir, file); }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    const meta = db.prepare('SELECT version,revision FROM metadata WHERE id=1').get();
    if (meta?.version !== 1 || !Number.isSafeInteger(meta.revision)) throw new Error('运行事实库版本或结构损坏');
    return { db, revision: meta.revision };
  } catch (error) { db.close(); throw error; }
}
function execute({ operation, dir, expectedRevision, changes, target: exportTarget }) {
  const { db, revision } = open(dir);
  try {
    if (operation === 'load' || operation === 'export') {
      db.exec('BEGIN');
      const snapshotRevision=db.prepare('SELECT revision FROM metadata WHERE id=1').get().revision;
      const state = empty();
      for (const row of db.prepare('SELECT kind,id,value FROM records').iterate()) {
        if (!tables.includes(row.kind)) throw new Error('运行事实库表损坏');
        Object.defineProperty(state[row.kind], row.id, { value: JSON.parse(row.value), writable: true, enumerable: true, configurable: true });
      }
      validate(state);
      db.exec('COMMIT');
      if (operation === 'export') {
        const target = exportTarget ?? path.join(dir, 'run-journal.json'), tmp = `${target}.${randomUUID()}.tmp`;
        const stamp = fs.statSync(path.join(dir, 'run-journal.sqlite'));
        try { fs.writeFileSync(tmp, JSON.stringify(state), {mode:0o600}); fs.utimesSync(tmp,stamp.atime,stamp.mtime); fs.renameSync(tmp, target); }
        finally { try { fs.unlinkSync(tmp); } catch {} }
        return true;
      }
      return { state, revision:snapshotRevision };
    }
    if (operation !== 'commit') throw new Error('未知运行事实库操作');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another writer/recovery cannot silently overwrite an earlier admission.
      const current = db.prepare('SELECT revision FROM metadata WHERE id=1').get().revision;
      if (current !== expectedRevision) throw Object.assign(new Error('运行事实库写入版本已变化，请重启后核对'), { code: 'journal-conflict' });
      const write = db.prepare('INSERT INTO records(kind,id,value) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value');
      for (const [table, records] of Object.entries(changes)) {
        if (!tables.includes(table)) throw new Error('运行事实库表无效');
        for (const [id, record] of Object.entries(records)) write.run(table, id, JSON.stringify(record));
      }
      db.prepare('UPDATE metadata SET revision=? WHERE id=1').run(current + 1);
      db.exec('COMMIT');
      return { revision: current + 1 };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  } finally { db.close(); }
}
function jsonOperation(request) {
  const {file,operation}=request;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(operation==='read-json'||operation==='read-fields'){
    let record=null,stamp=null;
    try{
      const s=fs.statSync(file);stamp=`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      record=JSON.parse(fs.readFileSync(file,'utf8'));
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(operation==='read-fields')return record?Object.fromEntries(request.fields.map(key=>[key,record[key]])):null;
    return {record,stamp};
  }
  const tmp=`${file}.worktmp-${randomUUID()}`;
  try{fs.writeFileSync(tmp,JSON.stringify(request.record,null,2),{mode:0o600});return tmp;}
  catch(error){try{fs.unlinkSync(tmp);}catch{}throw error;}
}
parentPort.on('message', ({ id, ...request }) => {
  try { parentPort.postMessage({ id, value: ['read-json','read-fields','prepare-json'].includes(request.operation)?jsonOperation(request):execute(request) }); }
  catch (error) { parentPort.postMessage({ id, error: { message: request.operation === 'load' ? `运行事实库读取失败：${error.message}` : error.message, name: error.name, code: error.code, stack: error.stack } }); }
});
