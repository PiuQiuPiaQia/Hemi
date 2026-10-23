import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function moduleUnderTest(file){
 const folder=mkdtempSync(path.join(tmpdir(),'hemi-flow-test-')),out=path.join(folder,'module.mjs');
 try{await build({entryPoints:[new URL(file,import.meta.url).pathname],outfile:out,bundle:true,platform:'node',format:'esm',external:['react','react-dom'],logLevel:'silent'});return await import(pathToFileURL(out));}finally{rmSync(folder,{recursive:true,force:true});}
}
