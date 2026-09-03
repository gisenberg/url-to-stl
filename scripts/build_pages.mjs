import { access, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultOutput = join(root, '_site');

function assertRepositoryChild(path, label) {
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`${label} must be inside the repository.`);
  }
}

async function replaceDirectory(path) {
  assertRepositoryChild(path, 'Pages output directory');
  await rm(path, { recursive: true, force: true });
}

export async function buildPages(destination = defaultOutput) {
  const output = resolve(destination);
  assertRepositoryChild(output, 'Pages output directory');
  const browserOutput = join(root, 'web', 'dist');
  await access(join(browserOutput, 'app.js')).catch(() => {
    throw new Error('Run `npm run build:web` before building GitHub Pages.');
  });

  const temporary = join(root, '.pages-build-temp');
  await replaceDirectory(temporary);
  await replaceDirectory(output);
  await mkdir(temporary);

  await Promise.all([
    cp(join(root, 'static', 'index.html'), join(temporary, 'index.html')),
    cp(join(root, 'static', 'style.css'), join(temporary, 'style.css')),
    cp(join(root, 'site', 'favicon.svg'), join(temporary, 'favicon.svg')),
    cp(join(browserOutput, 'app.js'), join(temporary, 'app.js')),
    cp(join(browserOutput, 'manifold.wasm'), join(temporary, 'manifold.wasm')),
    cp(join(browserOutput, 'licenses'), join(temporary, 'licenses'), { recursive: true }),
    cp(join(root, 'THIRD_PARTY.md'), join(temporary, 'THIRD_PARTY.md')),
    cp(join(root, 'static', 'vendor'), join(temporary, 'vendor'), { recursive: true }),
  ]);
  await mkdir(join(temporary, 'profiles'));
  await cp(join(root, 'profiles', 'x2d-04-pla.3mf'), join(temporary, 'profiles', 'x2d-04-pla.3mf'));
  await writeFile(join(temporary, '.nojekyll'), '');
  await rename(temporary, output);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildPages(process.argv[2] || defaultOutput);
  console.log(`Built GitHub Pages app at ${output}`);
}
