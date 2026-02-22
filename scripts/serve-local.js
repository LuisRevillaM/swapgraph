#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, relative, sep } from "node:path";

const PORT = Number(process.env.PORT) || 4173;
const ROOT = process.cwd();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const pathName = new URL(req.url ?? "/", "http://localhost").pathname;
  let filePath = resolve(ROOT, "." + pathName);

  const rel = relative(ROOT, filePath);
  const escaped =
    rel !== "" &&
    (rel.startsWith(`..${sep}`) ||
      rel === ".." ||
      isAbsolute(rel));

  if (escaped) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  if (statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
  }

  const body = readFileSync(filePath);
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`SwapGraph local server running at http://localhost:${PORT}`);
  console.log(`Serving files from ${ROOT}`);
});
