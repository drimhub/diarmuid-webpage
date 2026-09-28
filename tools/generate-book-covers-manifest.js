// Regenerates assets/book-covers/manifest.json from whatever image files
// are actually sitting in assets/book-covers/. Run this after adding or
// removing cover images:
//
//   node tools/generate-book-covers-manifest.js
//
// The site is static (no build step, no server-side directory listing),
// so the bookclub page can't discover these files on its own — it just
// fetches this manifest at runtime.

const fs = require('fs');
const path = require('path');

const COVERS_DIR = path.join(__dirname, '..', 'assets', 'book-covers');
const MANIFEST_PATH = path.join(COVERS_DIR, 'manifest.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const files = fs.readdirSync(COVERS_DIR)
  .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
  .sort();

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(files, null, 2) + '\n');
console.log(`Wrote ${files.length} file(s) to ${MANIFEST_PATH}`);
files.forEach((f) => console.log(' -', f));
