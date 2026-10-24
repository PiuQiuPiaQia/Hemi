import {build} from 'esbuild';
import {mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
export async function moduleUnderTest(file){
 const folder=mkdtempSync(path.join(tmpdir(),'hemi-flow-test-')),out=path.join(folder,'module.mjs');
 symlinkSync(fileURLToPath(new URL('../../../node_modules',import.meta.url)),path.join(folder,'node_modules'),'dir');
 try{await build({entryPoints:[fileURLToPath(new URL(file,import.meta.url))],outfile:out,bundle:true,platform:'node',format:'esm',external:['react','react-dom'],logLevel:'silent'});return await import(pathToFileURL(out));}finally{rmSync(folder,{recursive:true,force:true});}
}
