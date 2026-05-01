// packages/providers/restcrud/src/server/hono.ts

/**
 * @fileoverview Hono adapter for the framework-agnostic bulk handler.
 * @description Thin wrapper around {@link createBulkHandler} that extracts
 *   `{ headers, body, collection }` from a Hono `Context` and returns a
 *   standard `Response`. Works on Node, Bun, Deno, Cloudflare Workers — the
 *   same adapter handles every Hono runtime.
 *
 *   Hono is an OPTIONAL peer dependency — `type`-only imports at the top,
 *   no runtime import, so tree-shakers drop it.
 *
 * @version 0.1.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import { createBulkHandler } from './bulkHandler';
import type {
  BulkRequestContext,
  CreateBulkHandlerOptions,
} from './bulkHandler';

import type { Context } from 'hono';

/**
 * Normalise Hono's `Headers` object to the `Record<string, string |
 * string[] | undefined>` shape the core expects. Hono follows the Fetch
 * `Headers` contract (lower-cased keys, repeated values joined with `, `)
 * so no special treatment of `set-cookie` etc. is required here — the
 * inbound request headers we care about (authorisation, content-type,
 * cookie) are single-value.
 *
 * @internal
 */
function toHeadersRecord(
  headers: Headers
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Build a Hono handler `(c: Context) => Promise<Response>` for
 * `POST /:collection/bulk`.
 *
 * Expects Hono's path pattern to expose the collection via `c.req.param('collection')`.
 * The JSON body is parsed here via `await c.req.json()` — Hono does not
 * auto-parse the body the way Express does.
 *
 * @template TRow - Entity row type.
 * @param options - Same options as {@link createBulkHandler}.
 * @returns A Hono handler.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { createHonoBulkHandler } from '@donotdev/restcrud/server/hono';
 *
 * const app = new Hono();
 *
 * app.post(
 *   '/api/crud/:collection/bulk',
 *   createHonoBulkHandler({
 *     entity: eventEntity,
 *     createSchema,
 *     updateSchema,
 *     access: { create: 'user', update: 'user', delete: 'user' },
 *     authenticate: async (req) => {
 *       const header = req.headers['authorization'];
 *       if (typeof header !== 'string') throw new Error('Missing bearer token');
 *       return verifyJwt(header.replace(/^Bearer /, ''));
 *     },
 *     transact: async (prepared) => runDrizzleTransaction(prepared),
 *   }),
 * );
 *
 * export default app;
 * ```
 *
 * @since 0.2.0
 */
export function createHonoBulkHandler<TRow = unknown>(
  options: CreateBulkHandlerOptions<TRow>
): (c: Context) => Promise<Response> {
  const handle = createBulkHandler(options);

  return async function honoBulkHandler(c: Context): Promise<Response> {
    const collection = c.req.param('collection');
    if (!collection) {
      return Response.json(
        { error: 'Missing collection route parameter' },
        { status: 400 }
      );
    }

    // c.req.json() throws on malformed JSON — map to a 400 so clients see
    // the same status as a schema failure. Hono does not normalise this
    // for us and silent 500s mask real bugs.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Response.json({ error: 'Malformed JSON body' }, { status: 400 });
    }

    const context: BulkRequestContext = {
      headers: toHeadersRecord(c.req.raw.headers),
      body,
      collection,
    };

    const payload = await handle(context);
    return Response.json(payload.body, { status: payload.status });
  };
}
