import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const files = {
  base: new URL('../v1/masters/cafe-blue.png', import.meta.url),
  half: new URL('./assets/eye-half.png', import.meta.url),
  closed: new URL('./assets/eye-closed.png', import.meta.url),
};
const assets = {}, sources = {};
for (const [key, file] of Object.entries(files)) {
  const data = await fs.readFile(file);
  assets[key] = `data:image/png;base64,${data.toString('base64')}`;
  sources[key] = {
    file: key === 'base' ? '../v1/masters/cafe-blue.png' : `assets/eye-${key}.png`,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}
await fs.writeFile(new URL('./assets-data.js', import.meta.url), 'window.CHARACTER_ASSETS=' + JSON.stringify(assets) + ';\n');
await fs.writeFile(new URL('./sources.json', import.meta.url), JSON.stringify({
  method: 'Built-in image_gen for blink keyframe edits; source PNGs copied unmodified. Data URLs package original bytes for offline WebGL texture loading.',
  sources,
}, null, 2) + '\n');
console.log('Packaged source images unchanged in ' + fileURLToPath(new URL('.', import.meta.url)));
