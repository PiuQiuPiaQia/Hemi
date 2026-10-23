import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const root=import.meta.dirname, repo=path.resolve(root,'../../../..');
export default defineConfig({root,base:'./',plugins:[react()],resolve:{dedupe:['react','react-dom']},
  server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}},
  build:{outDir:path.join(repo,'.visual/workflow/mobile-design-v1-built'),emptyOutDir:true,rollupOptions:{input:{mobile:path.join(root,'index.html'),desktop:path.join(root,'desktop.html')}}}});
