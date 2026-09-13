import { describe, expect, it } from 'vitest';
import { loggableUrl } from '../../src/app.js';

const SESSION_ROUTE = '/api/auth/sessions/:id';

describe('loggableUrl', () => {
  it('leaves a url with no query string alone', () => {
    expect(loggableUrl('/api/todos', '/api/todos', undefined)).toBe('/api/todos');
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

  it('leaves the url alone when there is no q at all', () => {
    expect(
      loggableUrl('/api/todos?limit=5&deleted=true', '/api/todos', {
        limit: '5',
        deleted: 'true',
      }),
    ).toBe('/api/todos?limit=5&deleted=true');
  });

  it('redacts a session id by route template regardless of query', () => {
    expect(loggableUrl('/api/auth/sessions/abc-123', SESSION_ROUTE, undefined)).toBe(SESSION_ROUTE);
  });

  it('redacts q from the clean pass regardless of which route matched', () => {
    // Round 1: the original design keyed redaction on the matched route
    // template, so a trailing slash matching /api/todos/:id instead of
    // /api/todos fell through unredacted. The clean pass here looks only at
    // the literal '?' in the url, not the route, so this class of near-miss
    // no longer depends on the redaction set at all.
    expect(
      loggableUrl('/api/todos/?q=TrailingSlashNeedle', '/api/todos/:id', {
        q: 'TrailingSlashNeedle',
      }),
    ).toBe('/api/todos/?q=%5Bredacted%5D');
  });

  it('redacts a literal second "?" inside an earlier value without corrupting it', () => {
    // Round 2: url.split('?') truncated at the SECOND '?', which is legal
    // inside a query string value per RFC 3986.
    expect(
      loggableUrl('/api/todos?a=b?c&q=CraftedQueryNeedle', '/api/todos', {
        a: 'b?c',
        q: 'CraftedQueryNeedle',
      }),
    ).toBe('/api/todos?a=b%3Fc&q=%5Bredacted%5D');
  });

  it('redacts a "#"-delimited query in place, sharing the same boundary find-my-way uses', () => {
    // Round 3: find-my-way splits path from query at whichever of '?' or '#'
    // comes first. QUERY_DELIMITER matches both, so the clean pass now finds
    // this query string exactly where the router does, rather than needing
    // the parsed `query` fallback to tell it q existed at all.
    expect(
      loggableUrl('/api/todos#q=FragmentDelimitedNeedle', '/api/todos', {
        q: 'FragmentDelimitedNeedle',
      }),
    ).toBe('/api/todos#q=%5Bredacted%5D');
  });

  it('redacts a percent-encoded value in place via the same shared boundary', () => {
    // Round 4: a fallback that tried to substring-match the RAW parsed value
    // against a URL that only held the ENCODED form never fired. The clean
    // pass needs no such match at all - it redacts by key, not by value.
    expect(
      loggableUrl('/api/todos#q=dr%20smith%20divorce', '/api/todos', {
        q: 'dr smith divorce',
      }),
    ).toBe('/api/todos#q=%5Bredacted%5D');
  });

  it('never runs the fallback — and never touches other parameters — when the clean pass already redacted q', () => {
    // Round 4 regression: an unconditional fallback substring-replaced the
    // search term across the whole url, corrupting the path and unrelated
    // parameters that happened to contain it (e.g. "1" inside "limit=10").
    expect(loggableUrl('/api/todos?limit=10&q=1', '/api/todos', { limit: '10', q: '1' })).toBe(
      '/api/todos?limit=10&q=%5Bredacted%5D',
    );
  });

  it('handles a duplicate-key q parsed as an array by Fastify', () => {
    expect(
      loggableUrl('/api/todos#q=first&q=second', '/api/todos', { q: ['first', 'second'] }),
    ).toBe('/api/todos#q=%5Bredacted%5D');
  });

  it('is a safe no-op when query claims a q but the url has no delimiter at all', () => {
    // There is nothing in the url text to redact around or drop: with no
    // '?', '#', or ';' present, there is no query-string region for the
    // value to occupy, so the url passes through unchanged.
    expect(loggableUrl('/api/todos', '/api/todos', { q: 'GhostNeedle' })).toBe('/api/todos');
  });

  it('a decoy "?" after the real delimiter cannot mask the real query string', () => {
    // Round 6: the clean pass and its own "did Fastify see a q" check used to
    // computed the query-string boundary two different ways (`indexOf('?')`
    // vs `search(/[?#;]/)`), so a URL with '#' before a later '?' let the
    // clean pass parse the wrong region, find an unrelated decoy `q` there,
    // and short-circuit before ever reaching the real one. There is now
    // exactly one boundary computation, so both passes always agree.
    expect(
      loggableUrl('/api/todos#q=SECRETNEEDLE?q=decoy', '/api/todos', {
        q: 'SECRETNEEDLE?q=decoy',
      }),
    ).toBe('/api/todos#q=%5Bredacted%5D');
  });

  it('is a no-op when q is present in the query object but empty', () => {
    expect(loggableUrl('/api/todos?q=', '/api/todos', { q: '' })).toBe(
      '/api/todos?q=%5Bredacted%5D',
    );
  });

  it('leaves the url alone when the parsed query has no q key', () => {
    expect(loggableUrl('/api/todos#unrelated=1', '/api/todos', { unrelated: '1' })).toBe(
      '/api/todos#unrelated=1',
    );
  });
});
