#!/usr/bin/env node
import { readdir, writeFile } from 'node:fs/promises';

const dir = new URL('../drizzle/', import.meta.url);
const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run db:new -- <snake_case_name>');
  process.exit(1);
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
const last = files.at(-1);
const next = String((last ? Number(last.slice(0, 4)) : 0) + 1).padStart(4, '0');
const filename = `${next}_${name}.sql`;

await writeFile(
  new URL(filename, dir),
  `-- ${filename}\n-- Expand/contract: this migration must leave the CURRENTLY DEPLOYED code working.\n-- Additive changes only in the same PR as app code. Drops go in a later PR.\n\n`,
);
console.log(`Created drizzle/${filename}`);
