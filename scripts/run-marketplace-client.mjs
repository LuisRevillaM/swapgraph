import { createServer } from 'node:http';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '../client/marketplace');

const host = process.env.CLIENT_HOST ?? '127.0.0.1';
const port = Number.parseInt(String(process.env.CLIENT_PORT ?? '4173'), 10);
const runtimeBaseUrl = String(
  process.env.RUNTIME_SERVICE_URL
  ?? process.env.RENDER_SERVICE_URL
  ?? 'https://swapgraph-runtime-api.onrender.com'
).replace(/\/+$/g, '');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon']
]);

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function toContentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function safeFilePathFromUrlPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath || '/');
  const normalized = path.posix.normalize(decodedPath);
  const localPath = normalized === '/' ? '/index.html' : normalized;
  const resolved = path.resolve(clientRoot, `.${localPath}`);
  if (!resolved.startsWith(clientRoot)) return null;
  return resolved;
}

function filterForwardHeaders(headers) {
  const allowed = new Set([
    'authorization',
    'content-type',
    'idempotency-key',
    'x-actor-type',
    'x-actor-id',
    'x-auth-scopes',
    'x-csrf-token',
    'x-now-iso'
  ]);
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = String(key).toLowerCase();
    if (!allowed.has(normalized)) continue;
    if (value === undefined) continue;
    out[normalized] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

function setCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-actor-type, x-actor-id, x-auth-scopes, x-csrf-token, x-now-iso');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

async function proxyApi({ req, res, pathname, search }) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const upstreamPath = pathname === '/api' ? '/' : pathname.replace(/^\/api/, '');
  const targetUrl = `${runtimeBaseUrl}${upstreamPath}${search ?? ''}`;
  const method = req.method ?? 'GET';
  const headers = filterForwardHeaders(req.headers);
  const body = method === 'GET' || method === 'HEAD' ? null : await readBodyBuffer(req);

  let upstreamResponse = null;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined
    });
  } catch (error) {
    setCorsHeaders(res);
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: String(error?.message ?? error),
        target_url: targetUrl
      }
    }));
    return;
  }

  const raw = Buffer.from(await upstreamResponse.arrayBuffer());
  const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json; charset=utf-8';

  setCorsHeaders(res);
  res.writeHead(upstreamResponse.status, {
    'content-type': contentType,
    'x-proxy-upstream': runtimeBaseUrl
  });
  res.end(raw);
}

function serveStatic({ res, pathname }) {
  const filePath = safeFilePathFromUrlPath(pathname);
  if (!filePath) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  let stats = null;
  try {
    stats = statSync(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  if (!stats.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const content = readFileSync(filePath);
  res.writeHead(200, { 'content-type': toContentType(filePath) });
  res.end(content);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (isApiPath(url.pathname)) {
      await proxyApi({
        req,
        res,
        pathname: url.pathname,
        search: url.search
      });
      return;
    }
    serveStatic({ res, pathname: url.pathname });
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: {
        code: 'CLIENT_PROXY_INTERNAL_ERROR',
        message: String(error?.message ?? error)
      }
    }));
  }
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`[marketplace-client] listening on http://${host}:${port}`);
  // eslint-disable-next-line no-console
  console.log(`[marketplace-client] proxying /api/* to ${runtimeBaseUrl}`);
});
