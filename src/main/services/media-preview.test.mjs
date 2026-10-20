import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMediaPreviewRegistry } from './media-preview.mjs';

test('媒体按范围读取：前段、拖动、后缀、HEAD、越界与失效令牌', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-media-'));
  const target = path.join(dir, 'video.mp4'); fs.writeFileSync(target, '0123456789');
  try {
    const registry = createMediaPreviewRegistry(); let allowed = true, reads = 0;
    const url = registry.register(() => { reads += 1; return allowed ? { path: target, mime: 'video/mp4' } : null; });
    assert.ok(!url.includes(target));
    const request = (range, method = 'GET') => registry.respond(new Request(url, { method, headers: range ? { Range: range } : {} }));
    let response = await request('bytes=0-3');
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/10'); assert.equal(await response.text(), '0123');
    response = await request('bytes=7-'); assert.equal(await response.text(), '789');
    response = await request('bytes=-2'); assert.equal(await response.text(), '89');
    response = await request(null, 'HEAD'); assert.equal(response.headers.get('Content-Length'), '10'); assert.equal(await response.text(), '');
    for (const range of ['bytes=99-', 'bytes=6-2', 'bytes=-0', 'bytes=0-1,3-4']) assert.equal((await request(range)).status, 416);
    allowed = false; assert.equal((await request('bytes=0-')).status, 404);
    assert.ok(reads >= 9, '每次请求重新查证，而不是凭首次读取永久放行');
    assert.equal((await registry.respond(new Request('hemi-media://preview/missing'))).status, 404);
    allowed = true; fs.rmSync(target); assert.equal((await request(null)).status, 404);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
