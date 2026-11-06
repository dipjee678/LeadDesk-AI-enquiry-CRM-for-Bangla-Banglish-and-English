// Local dev server: serves public/ and runs the same api/*.js handlers Vercel runs.
// Usage: node --env-file-if-exists=.env dev-server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };

  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (api) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    req.body = raw ? JSON.parse(raw) : {};
    try {
      const mod = await import(pathToFileURL(path.join(root, "api", `${api[1]}.js`)).href);
      return mod.default(req, res);
    } catch {
      return res.status(404).json({ error: "Not found" });
    }
  }

  const file = path.join(root, "public", url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
  if (!file.startsWith(path.join(root, "public"))) return res.status(403).end();
  try {
    const data = await readFile(file);
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.status(404).end("Not found");
  }
}).listen(PORT, () => console.log(`LeadDesk running at http://localhost:${PORT}`));
