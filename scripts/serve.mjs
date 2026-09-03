import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { defaultOutput } from './build_pages.mjs';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.3mf': 'model/3mf',
};
const siteRoot = resolve(defaultOutput);
const listenPort = Number(process.env.QR_TOKEN_PORT || 8768);

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('QR_TOKEN_PORT must be a valid TCP port.');
}
await stat(join(siteRoot, 'index.html')).catch(() => {
  throw new Error('Run `npm run build` before starting the local static server.');
});

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    const relativePath = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    const filePath = resolve(join(siteRoot, relativePath));
    if (filePath !== siteRoot && !filePath.startsWith(`${siteRoot}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('Not found');
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': details.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`QR Token Studio is available at http://127.0.0.1:${listenPort}/`);
});
