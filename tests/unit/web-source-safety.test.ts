import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The client is hand-written DOM code, which is where XSS lives (ADR 0006).
 * This scan is one of the three defences: no HTML-injection sink may exist in
 * `web/` at all, so an injected string has nowhere to become markup.
 */

const WEB_DIR = join(process.cwd(), 'web');

const SINKS = [
  { name: 'innerHTML', pattern: /innerHTML/ },
  { name: 'outerHTML', pattern: /outerHTML/ },
  { name: 'insertAdjacentHTML', pattern: /insertAdjacentHTML/ },
  { name: 'document.write', pattern: /document\s*\.\s*write/ },
  { name: 'eval', pattern: /\beval\b/ },
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe('the web client contains no HTML-injection sinks', () => {
  it('finds sources to scan', () => {
    expect(filesUnder(WEB_DIR).length).toBeGreaterThan(0);
  });

  it('has no innerHTML, insertAdjacentHTML, document.write, or eval anywhere under web/', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(WEB_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const sink of SINKS) {
        if (sink.pattern.test(source)) offenders.push(`${relative(WEB_DIR, file)}: ${sink.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no inline script or style in index.html and references only /app/ assets', () => {
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');

    // Every <script> must be an external module; an inline one would need
    // 'unsafe-inline' in the CSP, which is exactly what this forbids.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\ssrc="/);
      expect(body!.trim()).toBe('');
    }

    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son[a-z]+="/);

    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference.startsWith('/app/')).toBe(true);
    }
  });
});

describe('the web client binds only to ids that exist', () => {
  it('finds every byId() id in index.html', () => {
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));

    const requested = filesUnder(join(WEB_DIR, 'src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/byId(?:<[^>]*>)?\(\s*'([^']+)'/g)].map((m) => ({
        file: relative(WEB_DIR, file),
        id: m[1]!,
      })),
    );

    // byId() throws at runtime for a missing element, which in the browser is a
    // blank panel. Catch the typo here instead.
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter(({ id }) => !ids.has(id))).toEqual([]);
  });
});
