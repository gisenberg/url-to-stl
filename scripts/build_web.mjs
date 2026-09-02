import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'web', 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, 'web', 'app.js')],
  outfile: join(output, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  external: ['./vendor/three.module.js', 'node:module'],
  minify: true,
  legalComments: 'none',
});
await cp(join(root, 'node_modules', 'manifold-3d', 'manifold.wasm'), join(output, 'manifold.wasm'));
const licenses = [
  ['fflate', 'LICENSE', 'fflate-LICENSE.txt'],
  ['jsqr', 'LICENSE', 'jsqr-LICENSE.txt'],
  ['manifold-3d', 'LICENSE', 'manifold-3d-LICENSE.txt'],
  ['qrcode', 'license', 'qrcode-LICENSE.txt'],
  ['@fortawesome/free-brands-svg-icons', 'LICENSE.txt', 'fontawesome-free-brands-LICENSE.txt'],
  ['svg-pathdata', 'LICENSE', 'svg-pathdata-LICENSE.txt'],
];
await mkdir(join(output, 'licenses'));
for (const [name, filename, outputName] of licenses) {
  await cp(join(root, 'node_modules', name, filename), join(output, 'licenses', outputName));
}

console.log(`Built static browser generator at ${output}`);
