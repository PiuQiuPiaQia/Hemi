import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const repo=path.resolve(import.meta.dirname,'../../../..');
export default defineConfig({root:import.meta.dirname,base:'./',plugins:[react()],server:{host:'127.0.0.1',port:5274,strictPort:true,fs:{allow:[repo]}},build:{outDir:path.join(repo,'.visual/session-recovery-built'),emptyOutDir:true}});
