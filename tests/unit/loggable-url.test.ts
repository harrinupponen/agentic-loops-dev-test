import { describe, expect, it } from 'vitest';
import { loggableUrl } from '../../src/app.js';

const SESSION_ROUTE = '/api/auth/sessions/:id';

describe('loggableUrl', () => {
  it('leaves a url with no query string alone', () => {
    expect(loggableUrl('/api/todos', '/api/todos', {})).toBe('/api/todos');
  });

  it('redacts q while preserving every other parameter', () => {
    expect(
      loggableUrl('/api/todos?limit=10&deleted=false&q=1', '/api/todos', {
        limit: '10',
        deleted: 'false',
        q: '1',
      }),
    ).toBe('/api/todos?limit=10&deleted=false&q=%5Bredacted%5D');
  });

  it('leaves parameters alone when there is no q at all', () => {
    expect(
      loggableUrl('/api/todos?limit=5&deleted=true', '/api/todos', {
        limit: '5',
        deleted: 'true',
      }),
    ).toBe('/api/todos?limit=5&deleted=true');
  });

  it('redacts a session id by route template, never reaching the query logic', () => {
    expect(loggableUrl('/api/auth/sessions/abc-123', SESSION_ROUTE, { q: 'ignored' })).toBe(
      SESSION_ROUTE,
    );
  });

  it('redacts q regardless of which route matched', () => {
    // Round 1: the original design keyed redaction on the matched route
    // template, so a trailing slash matching /api/todos/:id instead of
    // /api/todos fell through unredacted. This design never looks at the
    // route to decide whether to redact q - only whether the route is the
    // one path-parameter case (sessions) with nothing to do with q at all.
    expect(
      loggableUrl('/api/todos/?q=TrailingSlashNeedle', '/api/todos/:id', {
        q: 'TrailingSlashNeedle',
      }),
    ).toBe('/api/todos/?q=%5Bredacted%5D');
  });

  it('is immune to a literal "?" inside another parameter value', () => {
    // Round 2: url.split('?') truncated at a second literal '?'. This design
    // never parses the query string out of `url` at all - the query is
    // rebuilt entirely from Fastify's own parsed `query` object, so a "?"
    // inside a value it already parsed is just a character in a string.
    expect(
      loggableUrl('/api/todos?a=b?c&q=CraftedQueryNeedle', '/api/todos', {
        a: 'b?c',
        q: 'CraftedQueryNeedle',
      }),
    ).toBe('/api/todos?a=b%3Fc&q=%5Bredacted%5D');
  });

  it('redacts a "#"-delimited query the same as a "?"-delimited one', () => {
    // Round 3: find-my-way splits path from query at whichever of '?' or '#'
    // comes first. This design gets the path from the WHATWG URL parser,
    // which drops everything from the first '?' or '#' the same way, and
    // rebuilds the query fresh - so there is nothing left to key off which
    // literal character delimited the original request.
    expect(
      loggableUrl('/api/todos#q=FragmentDelimitedNeedle', '/api/todos', {
        q: 'FragmentDelimitedNeedle',
      }),
    ).toBe('/api/todos?q=%5Bredacted%5D');
  });

  it('redacts a percent-encoded value the same as a plain one', () => {
    // Round 4: a fallback substring-matched the RAW parsed value against a
    // URL that only held the ENCODED form. This design never matches a value
    // against the url string at all - it redacts by key, so encoding is
    // irrelevant.
    expect(
      loggableUrl('/api/todos#q=dr%20smith%20divorce', '/api/todos', {
        q: 'dr smith divorce',
      }),
    ).toBe('/api/todos?q=%5Bredacted%5D');
  });

  it('never touches an unrelated parameter, even one containing q as a substring', () => {
    // Round 4 regression: an unconditional fallback substring-replaced the
    // search term across the WHOLE url, corrupting the path and unrelated
    // parameters that happened to contain it (e.g. "1" inside "limit=10").
    // Rebuilding each parameter independently from the parsed object makes
    // this class of corruption structurally impossible.
    expect(loggableUrl('/api/todos?limit=10&q=1', '/api/todos', { limit: '10', q: '1' })).toBe(
      '/api/todos?limit=10&q=%5Bredacted%5D',
    );
  });

  it('redacts every value of a duplicate-key q parsed as an array by Fastify', () => {
    expect(
      loggableUrl('/api/todos#q=first&q=second', '/api/todos', { q: ['first', 'second'] }),
    ).toBe('/api/todos?q=%5Bredacted%5D&q=%5Bredacted%5D');
  });

  it('is a no-op when q is present in the query object but empty', () => {
    expect(loggableUrl('/api/todos?q=', '/api/todos', { q: '' })).toBe(
      '/api/todos?q=%5Bredacted%5D',
    );
  });

  it('leaves the url alone when the parsed query has no q key', () => {
    expect(loggableUrl('/api/todos#unrelated=1', '/api/todos', { unrelated: '1' })).toBe(
      '/api/todos?unrelated=1',
    );
  });

  it('redacts correctly when a decoy "?" or "#" appears anywhere in the raw url', () => {
    // Round 6: two independent computations of the query-string boundary
    // could be made to disagree given a decoy delimiter. This design makes
    // no independent computation of q's location at all - a decoy character
    // anywhere in `url` cannot matter, because `url` is only ever consulted
    // for its path, never re-parsed for q.
    expect(
      loggableUrl('/api/todos#q=SECRETNEEDLE?q=decoy', '/api/todos', {
        q: 'SECRETNEEDLE?q=decoy',
      }),
    ).toBe('/api/todos?q=%5Bredacted%5D');
  });

  it('redacts correctly when a decoy ";" appears in the raw url', () => {
    // Round 7: an earlier fix asserted find-my-way also splits on ';', which
    // is only true with useSemicolonDelimiter set (this app does not set
    // it), so ';' is just a path character to the real router - but the
    // fix's own regex treated it as a third delimiter, creating exactly the
    // "second opinion about where the query starts" bug the fix was meant to
    // remove. This design has no opinion about ';' at all.
    expect(
      loggableUrl('/api/todos/abc;q=decoy&z=1?q=SECRETNEEDLE', '/api/todos/:id', {
        q: 'SECRETNEEDLE',
      }),
    ).toBe('/api/todos/abc;q=decoy&z=1?q=%5Bredacted%5D');
  });

  it('logs only the route when the url itself cannot be parsed', () => {
    // Node's own URL parser is the only thing this function asks to look at
    // `url`. RFC 7230 §5.3.2 allows an absolute-form request target (a proxy
    // artefact Fastify would never itself send but a raw client could), and
    // an incomplete one is genuinely invalid to the WHATWG parser - confirmed
    // empirically, not assumed. If parsing throws, nothing about `url` is
    // trustworthy enough to build a log line from, so only the route
    // template - never derived from `url` - is logged.
    expect(loggableUrl('http://', '/api/todos', { q: 'x' })).toBe('/api/todos');
  });
});
