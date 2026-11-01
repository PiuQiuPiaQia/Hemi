import test, {after} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRunJournal} from '../src/main/agent-runtime/run-journal.mjs';
import {inspectStorageForDiagnostics} from '../src/main/agent-runtime/journal-storage.mjs';
test('minimal durable storage lifecycle',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-minimal-storage-'));
  const journal=createRunJournal({dir}),owner={conversationId:'probe',rootRunId:'probe',generation:1};
  try{await journal.beginRoot(owner);await journal.finishRoot(owner,'completed');await journal.flush();}
  finally{journal.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
after(()=>{
  setTimeout(()=>{
    const report=process.report.getReport();
    console.error('MINIMAL_EXIT_DIAGNOSTICS='+JSON.stringify({resources:process.getActiveResourcesInfo(),storage:inspectStorageForDiagnostics(),libuv:report.libuv.filter(x=>x.is_active||x.is_referenced)}));
    process.exit(2);
  },5000).unref();
});
