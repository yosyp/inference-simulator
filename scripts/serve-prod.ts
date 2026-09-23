// Serves the production build (dist/) the way CloudFront does, for the production-CSP smoke
// test (00-build I4). Every response carries the headers in infra/site/headers.json verbatim,
// and Cache-Control follows 06 §6 and the sync commands in infra/README.md.
// Node built-ins only.
//
// Usage: tsx scripts/serve-prod.ts [port]    (or PORT=<port>; default 4180)

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';

const DEFAULT_PORT = 4180;
const HOST = '127.0.0.1';

const repoRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const headersFile = path.join(repoRoot, 'infra', 'site', 'headers.json');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// 06 §6: hashed assets are immutable; everything else (index.html) revalidates.
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'no-cache';

async function readSiteHeaders(): Promise<Record<string, string>> {
  const parsed: unknown = JSON.parse(await readFile(headersFile, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${headersFile} must be a JSON object of header names to values`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`${headersFile}: ${name} must be a string`);
    headers[name] = value;
  }
  return headers;
}

function parsePort(): number {
  const raw = process.argv[2] ?? process.env.PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

// Maps a URL path to a file inside dist/, or null. Only "/" maps to index.html, as with
// CloudFront's default root object; other directories never resolve, so there is no listing.
function resolveFile(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(distDir, relative);
  const inside = path.relative(distDir, file);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return file;
}

function sendText(res: ServerResponse, status: number, body: string, headOnly: boolean): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', CACHE_REVALIDATE);
  res.end(headOnly ? undefined : body);
}

async function main(): Promise<void> {
  const siteHeaders = await readSiteHeaders();
  const port = parsePort();

  const indexStats = await stat(path.join(distDir, 'index.html')).catch(() => null);
  if (!indexStats?.isFile()) {
    throw new Error(`${distDir}/index.html not found; run \`pnpm build\` first`);
  }

  const server = createServer((req, res) => {
    // headers.json applies verbatim to every response, errors included, as the
    // CloudFront response headers policy does.
    for (const [name, value] of Object.entries(siteHeaders)) res.setHeader(name, value);

    const headOnly = req.method === 'HEAD';
    if (req.method !== 'GET' && !headOnly) {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'Method Not Allowed\n', false);
      return;
    }

    const urlPath = new URL(req.url ?? '/', `http://${HOST}`).pathname;
    const file = resolveFile(urlPath);
    if (file === null) {
      sendText(res, 404, 'Not Found\n', headOnly);
      return;
    }

    stat(file).then(
      (stats) => {
        if (!stats.isFile()) {
          sendText(res, 404, 'Not Found\n', headOnly);
          return;
        }
        const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const inAssets = path.relative(distDir, file).split(path.sep)[0] === 'assets';
        res.statusCode = 200;
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', inAssets ? CACHE_IMMUTABLE : CACHE_REVALIDATE);
        if (headOnly) {
          res.end();
          return;
        }
        createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res);
      },
      () => sendText(res, 404, 'Not Found\n', headOnly),
    );
  });

  server.listen(port, HOST, () => {
    console.log(`Serving ${distDir} at http://${HOST}:${port} with infra/site/headers.json`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
