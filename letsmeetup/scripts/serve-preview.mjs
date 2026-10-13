// Local-only preview of the results view with fake data: no sign-in, no API keys, no database.
// Serves the real public/ files (so the real CSS, view.js and map.js are what you see) plus
// dev/results-preview.html at /preview, on all network interfaces so a phone on the same Wi-Fi can open it.
// Not deployed (dev/ and scripts/ are not part of public/). Usage (from letsmeetup/):  npm run preview

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5175;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  let file;
  if (path === '/preview' || path === '/') file = join(root, 'dev/results-preview.html');
  else if (path === '/preview.js') file = join(root, 'dev/results-preview.js');
  else file = join(root, 'public', normalize(path)); // normalize + prefix check keep it inside public/
  if (!file.startsWith(join(root, 'public')) && !file.startsWith(join(root, 'dev'))) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const body = await readFile(file); // read first, so a failure can still send a 404
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Preview:  http://localhost:${PORT}`);
  for (const addrs of Object.values(networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`On your phone (same Wi-Fi):  http://${a.address}:${PORT}`);
  console.log('Ctrl+C to stop');
});
