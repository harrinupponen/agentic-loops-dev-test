/**
 * Copies the client's static files next to the JavaScript `tsc` emitted.
 * `tsc -p web/tsconfig.json` writes dist/public/app/*.js; this puts
 * index.html at dist/public/index.html and the stylesheet beside the scripts,
 * which is the layout src/routes/web.ts serves.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repoRoot, 'dist', 'public');

const files = [
  ['web/index.html', 'index.html'],
  ['web/styles.css', 'app/styles.css'],
];

await mkdir(join(out, 'app'), { recursive: true });
for (const [from, to] of files) {
  await copyFile(join(repoRoot, from), join(out, to));
}

console.log(`Wrote ${files.length} static files to dist/public`);
