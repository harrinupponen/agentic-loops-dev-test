import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { allowedOrigins, type Config } from '../config.js';
import { notFound } from '../lib/errors.js';

/**
 * Serves the built browser client from the same origin as the API, so the
 * session cookie stays SameSite=Lax and the CSRF posture of ADR 0004 holds.
 *
 * Both routes are hidden from the OpenAPI document and exempt from the global
 * rate limit: a page load is three requests, and an office behind one NAT would
 * otherwise spend its budget on CSS. They read a file and touch no database.
 */
export async function registerWebRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const webRoot = path.resolve(process.cwd(), config.WEB_ROOT);
  const assetRoot = path.join(webRoot, 'app');

  // Rule 1: is this process serving a browser client at all?
  if (!existsSync(path.join(webRoot, 'index.html'))) {
    if (config.NODE_ENV === 'production') {
      throw new Error(
        `No web client at ${webRoot}/index.html. The production image must ship a built client; ` +
          'run `npm run build` or point WEB_ROOT at the build output.',
      );
    }
    app.log.warn({ webRoot }, 'no web client found; serving the API only');
    return;
  }

  // Rule 2: an empty allowlist disables the CSRF origin check entirely, so
  // serving a cookie-authenticated browser client against it is a boot failure
  // in every NODE_ENV — see docs/adr/0007-fail-closed-security-config.md.
  const origins = allowedOrigins(config);
  if (origins.length === 0) {
    throw new Error(
      `ALLOWED_ORIGINS is empty while WEB_ROOT (${webRoot}) is serving a browser client. ` +
        'That disables the CSRF origin check. Set ALLOWED_ORIGINS to the site origin.',
    );
  }

  await app.register(fastifyStatic, {
    root: webRoot,
    // The routes are declared by hand below so they can opt out of the rate
    // limit and out of the API contract.
    serve: false,
    index: false,
    dotfiles: 'deny',
    etag: true,
    // Filenames are not content-hashed (no bundler), so a stale asset against a
    // newer API is the failure mode to avoid: revalidate every time.
    cacheControl: false,
  });

  app.get('/', { config: { rateLimit: false }, schema: { hide: true } }, (_request, reply) => {
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html', webRoot);
  });

  app.get(
    '/app/*',
    { config: { rateLimit: false }, schema: { hide: true } },
    async (request, reply) => {
      const requested = (request.params as Record<string, string>)['*'] ?? '';
      const target = path.resolve(assetRoot, requested);

      // WEB_ROOT is server-side configuration; the request only ever picks a
      // file inside it. Anything resolving outside, or any dotfile, is a 404 —
      // never a 403, which would confirm the path exists.
      const escapes = target !== assetRoot && !target.startsWith(assetRoot + path.sep);
      const dotted = requested.split('/').some((segment) => segment.startsWith('.'));
      if (escapes || dotted) throw notFound('Asset not found');

      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) throw notFound('Asset not found');

      reply.header('cache-control', 'no-cache');
      return reply.sendFile(path.relative(webRoot, target), webRoot);
    },
  );

  const assetCount = (await readdir(assetRoot).catch(() => [])).length;
  // Proves from the logs alone that this container holds a client and that the
  // origin allowlist is populated. By rule 2, originCount can never be 0 here.
  app.log.info({ webRoot, assetCount, originCount: origins.length }, 'serving web client');
}
