// packages/providers/restcrud/src/server/express.ts

/**
 * @fileoverview Express adapter for the framework-agnostic bulk handler.
 * @description Thin wrapper around {@link createBulkHandler} that extracts
 *   `{ headers, body, collection }` from an Express `Request` and writes the
 *   resulting {@link BulkResponsePayload} back via `res.status().json()`.
 *
 *   Express is an OPTIONAL peer dependency — consumers who don't use Express
 *   pay nothing at install time, and the adapter only type-imports from it
 *   so tree-shakers drop it entirely.
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

import type { Request, RequestHandler, Response } from 'express';

/**
 * Build an Express `RequestHandler` for `POST /:collection/bulk`.
 *
 * Wire-up expects Express to have already run a JSON body parser
 * (`express.json()`) and a route param named `collection`. Rejects with 405
 * for any non-POST method — keep the router mounting permissive
 * (`router.all(...)`) and let the adapter gate, or mount `router.post(...)`
 * only and skip the 405 branch.
 *
 * @template TRow - Entity row type.
 * @param options - Same options as {@link createBulkHandler}.
 * @returns An Express `RequestHandler`.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { createExpressBulkHandler } from '@donotdev/restcrud/server/express';
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.post(
 *   '/api/crud/:collection/bulk',
 *   createExpressBulkHandler({
 *     entity: eventEntity,
 *     createSchema,
 *     updateSchema,
 *     access: { create: 'user', update: 'user', delete: 'user' },
 *     authenticate: async (req) => {
 *       const uid = req.headers['x-user-id'];
 *       if (typeof uid !== 'string') throw new Error('Missing x-user-id');
 *       return { uid, userRole: 'user' };
 *     },
 *     transact: async (prepared) => runPgTransaction(prepared),
 *   }),
 * );
 * ```
 *
 * @since 0.2.0
 */
export function createExpressBulkHandler<TRow = unknown>(
  options: CreateBulkHandlerOptions<TRow>
): RequestHandler {
  const handle = createBulkHandler(options);

  return async function expressBulkHandler(
    req: Request,
    res: Response
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const rawCollection = req.params['collection'];
    if (typeof rawCollection !== 'string' || rawCollection.length === 0) {
      res.status(400).json({ error: 'Missing collection route parameter' });
      return;
    }

    const context: BulkRequestContext = {
      headers: req.headers,
      body: req.body,
      collection: rawCollection,
    };

    const payload = await handle(context);
    res.status(payload.status).json(payload.body);
  };
}
