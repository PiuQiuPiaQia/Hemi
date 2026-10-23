import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import path from 'node:path';
const root=import.meta.dirname,repo=path.resolve(root,'../../../..');
export default defineConfig({root,base:'./',plugins:[{name:'prototype-no-dev-hud',enforce:'pre',resolveId(id,importer){if(id.includes('dev-performance-monitor')&&importer?.includes('app-top-bar'))return '\0bot3-no-hud';},load(id){if(id==='\0bot3-no-hud')return 'export default function NoDevHud(){return null}';}},react()],css:{postcss:{plugins:[tailwindcss()]}},resolve:{alias:{'@':path.join(repo,'src/renderer/src'),'@shared':path.join(repo,'src/shared')}},server:{host:'127.0.0.1',port:0,fs:{allow:[repo]}},optimizeDeps:{include:['react','react-dom/client','stats.js']},build:{outDir:path.join(repo,'.visual/workflow/bot-v3-built'),emptyOutDir:true}});
