import {createServer} from 'vite';
import path from 'node:path';
const server=await createServer({configFile:path.join(import.meta.dirname,'vite.config.mjs')});
await server.listen();server.printUrls();
