/**
 * Build script — scans media/ directory and generates media.json
 * Run via: npm run build (or node scripts/generate-media-json.js)
 */

const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const OUTPUT_FILE = path.join(__dirname, '..', 'media.json');

const VALID_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif',
  'mp4', 'webm',
]);

const VALID_FILENAME = /^[^/\\:.*?#][^/\\:*?#]*$/;

function getExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 1) return '';
  return filename.slice(dotIndex + 1).toLowerCase();
}

function generate() {
  if (!fs.existsSync(MEDIA_DIR)) {
    console.warn('media/ directory not found — writing empty media.json');
    fs.writeFileSync(OUTPUT_FILE, '[]\\n');
    return;
  }

  const entries = fs.readdirSync(MEDIA_DIR);
  const valid = [];
  const skipped = [];

  for (const name of entries) {
    const fullPath = path.join(MEDIA_DIR, name);

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      skipped.push({ name, reason: 'stat failed' });
      continue;
    }

    if (!stat.isFile()) {
      skipped.push({ name, reason: 'not a file' });
      continue;
    }

    if (!VALID_FILENAME.test(name)) {
      skipped.push({ name, reason: 'invalid filename' });
      continue;
    }

    const ext = getExtension(name);
    if (!VALID_EXTENSIONS.has(ext)) {
      skipped.push({ name, reason: `unsupported extension: .${ext || '(none)'}` });
      continue;
    }

    valid.push(name);
  }

  valid.sort();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(valid, null, 2) + '\n');

  console.log(`media.json generated: ${valid.length} files`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} entries:`);
    for (const { name, reason } of skipped) {
      console.log(`  - ${name} (${reason})`);
    }
  }
}

generate();
