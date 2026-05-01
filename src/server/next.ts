// packages/providers/restcrud/src/server/next.ts

/**
 * @fileoverview Next.js adapter for the framework-agnostic bulk handler.
 * @description Two exports, one per routing model:
 *   - {@link createNextAppBulkHandler} — Next 13+ App Router route handler
 *     `(req: NextRequest, ctx: { params }) => Promise<NextResponse>`.
 *   - {@link createNextPagesBulkHandler} — Pages Router API route
 *     `(req: NextApiRequest, res: NextApiResponse) => Promise<void>`.
 *
 *   Next.js is an OPTIONAL peer dependency — only type imports.
 *
 *   Note: the App Router passes dynamic segments via a second `context`
 *   argument (`{ params: Promise<{ collection: string }> }` in Next 15+,
 *   or synchronous `{ params: { collection: string } }` in Next 13–14).
 *   We accept either by awaiting `context.params` unconditionally —
 *   awaiting a non-thenable is a no-op.
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

import type { NextApiRequest, NextApiResponse } from 'next';
import type { NextRequest } from 'next/server';

/**
 * Shape of the second argument passed by Next 13+ App Router dynamic
 * route handlers. `params` is sync in Next 13/14 and async (thenable) in
 * Next 15+ — we handle both via `await`.
 *
 * @since 0.2.0
 */
export interface NextAppRouteContext {
  params: { collection?: string } | Promise<{ collection?: string }>;
}

/**
 * Normalise Fetch-style `Headers` into the core record shape.
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
 * Build a Next 13+ App Router route handler for
 * `app/api/crud/[collection]/bulk/route.ts`.
 *
 * Returns a `Response` (usable wherever App Router route handlers are
 * typed as `NextResponse` — they are structurally compatible). We return
 * the vanilla `Response` so the handler also works in edge runtime and
 * any framework-adjacent runner that accepts the Fetch `Response`.
 *
 * @template TRow - Entity row type.
 * @param options - Same options as {@link createBulkHandler}.
 * @returns An App Router route handler.
 *
 * @example
 * ```ts
 * // app/api/crud/[collection]/bulk/route.ts
 * import { createNextAppBulkHandler } from '@donotdev/restcrud/server/next';
 *
 * export const POST = createNextAppBulkHandler({
 *   entity: eventEntity,
 *   createSchema,
 *   updateSchema,
 *   access: { create: 'user', update: 'user', delete: 'user' },
 *   authenticate: async (req) => {
 *     const cookie = req.headers['cookie'];
 *     if (typeof cookie !== 'string') throw new Error('No session');
 *     return resolveSession(cookie);
 *   },
 *   transact: async (prepared) => runDrizzleTransaction(prepared),
 * });
 * ```
 *
 * @since 0.2.0
 */
export function createNextAppBulkHandler<TRow = unknown>(
  options: CreateBulkHandlerOptions<TRow>
): (req: NextRequest, context: NextAppRouteContext) => Promise<Response> {
  const handle = createBulkHandler(options);

  return async function nextAppBulkHandler(
    req: NextRequest,
    context: NextAppRouteContext
  ): Promise<Response> {
    const params = await Promise.resolve(context.params);
    const collection = params?.collection;
    if (typeof collection !== 'string' || collection.length === 0) {
      return Response.json(
        { error: 'Missing collection route parameter' },
        { status: 400 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Malformed JSON body' }, { status: 400 });
    }

    const bulkContext: BulkRequestContext = {
      headers: toHeadersRecord(req.headers),
      body,
      collection,
    };

    const payload = await handle(bulkContext);
    return Response.json(payload.body, { status: payload.status });
  };
}

/**
 * Build a Next.js Pages Router API handler for
 * `pages/api/crud/[collection]/bulk.ts`. Mirrors the Vercel handler at
 * `packages/functions/src/vercel/api/crud/bulk.ts` but delegates auth and
 * transact to the consumer, so it works for any backend (not just
 * Firebase admin).
 *
 * The collection is read from `req.query.collection` (Next injects dynamic
 * route params there).
 *
 * @template TRow - Entity row type.
 * @param options - Same options as {@link createBulkHandler}.
 * @returns A Pages Router API handler.
 *
 * @example
 * ```ts
 * // pages/api/crud/[collection]/bulk.ts
 * import { createNextPagesBulkHandler } from '@donotdev/restcrud/server/next';
 *
 * export default createNextPagesBulkHandler({
 *   entity: eventEntity,
 *   createSchema,
 *   updateSchema,
 *   access: { create: 'user', update: 'user', delete: 'user' },
 *   authenticate: async (req) => resolveSession(req.headers['cookie']),
 *   transact: async (prepared) => runPrismaTransaction(prepared),
 * });
 * ```
 *
 * @since 0.2.0
 */
export function createNextPagesBulkHandler<TRow = unknown>(
  options: CreateBulkHandlerOptions<TRow>
): (req: NextApiRequest, res: NextApiResponse) => Promise<void> {
  const handle = createBulkHandler(options);

  return async function nextPagesBulkHandler(
    req: NextApiRequest,
    res: NextApiResponse
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const raw = req.query['collection'];
    const collection = typeof raw === 'string' ? raw : raw?.[0];
    if (typeof collection !== 'string' || collection.length === 0) {
      res.status(400).json({ error: 'Missing collection route parameter' });
      return;
    }

    const context: BulkRequestContext = {
      headers: req.headers,
      body: req.body,
      collection,
    };

    const payload = await handle(context);
    res.status(payload.status).json(payload.body);
  };
}
