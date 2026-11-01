// Offline/verification tooling only. Production uses journal-storage's IO worker.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {JOURNAL_TABLES} from './journal-draft.mjs';

export function readRunJournalFileSync(file) {
  if (file.endsWith('run-journal.json')) {
    const sqlite = path.join(path.dirname(file), 'run-journal.sqlite');
    if (!fs.existsSync(sqlite)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    file = sqlite;
  }
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    const state = {version:2, ...Object.fromEntries(JOURNAL_TABLES.map(table=>[table,{}]))};
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    if (db.prepare('SELECT version FROM metadata WHERE id=1').get()?.version !== 1) throw new Error('运行事实库版本损坏');
    for (const row of db.prepare('SELECT kind,id,value FROM records').iterate()) {
      if (!JOURNAL_TABLES.includes(row.kind)) throw new Error('运行事实库表损坏');
      Object.defineProperty(state[row.kind],row.id,{value:JSON.parse(row.value),writable:true,enumerable:true,configurable:true});
    }
    return state;
  } finally { db.close(); }
}
