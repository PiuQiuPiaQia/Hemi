import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const source = (name: string) => path.resolve(import.meta.dirname, '../../packages/conversation-flow/src', name);
export default defineConfig(({command}) => ({
  base: './', plugins: [react()],
  resolve: {dedupe: ['react','react-dom'], alias: command === 'serve' ? {
    '@hemi/conversation-flow/styles.css': path.resolve(import.meta.dirname, '../../packages/conversation-flow/dist/styles.css'),
    '@hemi/conversation-flow/styles': path.resolve(import.meta.dirname, '../../packages/conversation-flow/dist/styles'),
    ...Object.fromEntries(['core','react','parts','types','composer','controls','navigation','resources'].map(name=>['@hemi/conversation-flow/'+name,source(name+'.ts')])),
    '@hemi/conversation-flow/web-host': source('adapters/web-host.ts'),
    '@hemi/conversation-flow/native-host': source('adapters/native-host.ts'),
    '@hemi/conversation-flow': source('index.ts'),
  } : {}},
  build: {target:'es2022',sourcemap:false,license:true},
}));
