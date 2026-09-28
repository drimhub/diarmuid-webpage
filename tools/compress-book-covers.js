// One-off/rerunnable pass to shrink whatever's in assets/book-covers/ down to
// a sane size for a rotating thumbnail. Resizes to fit within 600x600 and
// re-encodes as JPEG (quality 82), overwriting PNGs in place as .jpg.
//
// Requires `sharp` (npm install sharp --no-save in this tools/ folder).
//
//   node tools/compress-book-covers.js
//
// Re-run tools/generate-book-covers-manifest.js afterwards.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const COVERS_DIR = path.join(__dirname, '..', 'assets', 'book-covers');
const MAX_DIM = 600;
const JPEG_QUALITY = 82;

async function main() {
  const files = fs.readdirSync(COVERS_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));

  for (const file of files) {
    const srcPath = path.join(COVERS_DIR, file);
    const beforeSize = fs.statSync(srcPath).size;

    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const destPath = path.join(COVERS_DIR, `${base}.jpg`);
    const tmpPath = `${destPath}.tmp`;

    // Read fully into memory first so sharp doesn't hold srcPath open —
    // on Windows that blocks renaming/overwriting it below.
    const inputBuffer = fs.readFileSync(srcPath);
    const outputBuffer = await sharp(inputBuffer)
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    fs.writeFileSync(tmpPath, outputBuffer);

    if (destPath !== srcPath) fs.unlinkSync(srcPath);
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    fs.renameSync(tmpPath, destPath);

    const afterSize = fs.statSync(destPath).size;
    console.log(
      `${file} -> ${path.basename(destPath)}: ${(beforeSize / 1024).toFixed(0)}KB -> ${(afterSize / 1024).toFixed(0)}KB`
    );
  }
}

main();
