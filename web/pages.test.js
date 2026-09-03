import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildPages, root } from '../scripts/build_pages.mjs';

test('Pages build refuses to replace directories outside the repository', async () => {
  await assert.rejects(
    buildPages(join(root, '..', 'outside-pages-build')),
    /must be inside the repository/,
  );
});

test('Pages build contains the complete generator without server routes', async () => {
  const output = join(root, '.pages-build-test');
  try {
    await buildPages(output);
    const [html, app] = await Promise.all([
      readFile(join(output, 'index.html'), 'utf8'),
      readFile(join(output, 'app.js'), 'utf8'),
    ]);
    for (const expected of [
      'BROWSER WORKSPACE',
      'Business card',
      'Brand icon',
      'Shape style',
      'Lines',
      'Triangles',
      'Finder frame',
      'Finder center',
      'Outer framing',
      'Double',
      'Band width',
      'Edge gap',
      '<details id="qr-advanced" open>',
      'Light border padding',
      'Corner radius',
      'Center badge',
      'Flat · dark code flush with a light face',
      'Two pieces · separate base and cap',
      'Download Bambu 3MF',
      'SVG geometry',
    ]) assert.ok(html.includes(expected), `Missing page content: ${expected}`);
    for (const excluded of ['A LINK YOU CAN HOLD', 'Small token.', 'Download for Windows']) {
      assert.ok(!html.includes(excluded), `Unexpected page content: ${excluded}`);
    }
    assert.ok(!app.includes('/api/'));
    for (const relativePath of [
      'manifold.wasm',
      'profiles/x2d-04-pla.3mf',
      'vendor/three.module.js',
      'licenses/manifold-3d-LICENSE.txt',
      'licenses/fontawesome-free-brands-LICENSE.txt',
      'licenses/svg-pathdata-LICENSE.txt',
    ]) assert.ok((await stat(join(output, relativePath))).isFile(), `Missing output: ${relativePath}`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
