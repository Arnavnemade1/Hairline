/**
 * Static file server for site/ — `npm run site`.
 *
 * The landing page has no build step and no dependencies, so this exists only
 * to serve it over http rather than file:// during development. It reads from
 * site/ and nowhere else.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'site');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const relative = normalize(path === '/' ? 'index.html' : path.slice(1));
  const file = join(ROOT, relative);

  // A request may not climb out of site/.
  if (!file.startsWith(ROOT + '/')) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`hairline site → http://localhost:${PORT}`);
});
