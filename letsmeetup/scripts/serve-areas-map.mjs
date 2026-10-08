// Local-only viewer for the area list: serves dev/areas-map.html plus the two files it needs on
// http://localhost:5174 (not deployed; the dev/ folder is not part of public/).
// Usage (from letsmeetup/):  npm run areas:map

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5174;

const FILES = {
  '/': ['dev/areas-map.html', 'text/html; charset=utf-8'],
  '/snap.js': ['public/snap.js', 'text/javascript; charset=utf-8'],
  '/areas.json': ['public/areas.json', 'application/json'],
  '/extras.json': ['dev/extras.json', 'application/json'],
};

createServer(async (req, res) => {
  const entry = FILES[new URL(req.url, 'http://x').pathname];
  if (!entry) { res.writeHead(404).end('Not found'); return; }
  try {
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
    res.end(await readFile(join(root, entry[0])));
  } catch {
    res.writeHead(500).end('Read error');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Areas map: http://localhost:${PORT}  (Ctrl+C to stop)`));
