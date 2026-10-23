import {createServer} from 'vite';
import path from 'node:path';
const s=await createServer({configFile:path.join(import.meta.dirname,'vite.config.mjs')});await s.listen();s.printUrls();
