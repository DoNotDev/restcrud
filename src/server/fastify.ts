// packages/providers/restcrud/src/server/fastify.ts

/**
 * @fileoverview Fastify adapter for the framework-agnostic bulk handler.
 * @description Thin wrapper around {@link createBulkHandler} that extracts
 *   `{ headers, body, collection }` from a Fastify `FastifyRequest` and
 *   writes the response via `reply.status().send()`.
 *
 *   Fastify is an OPTIONAL peer dependency — only type imports, so
 *   consumers who don't use Fastify pay nothing.
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

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

/**
 * Build a Fastify route handler for `POST /:collection/bulk`.
 *
 * Fastify auto-parses JSON bodies via its default content-type parser, so
 * `request.body` is already a parsed object. The route pattern must expose
 * the collection as `:collection` so it lands in `request.params`.
 *
 * @template TRow - Entity row type.
 * @param options - Same options as {@link createBulkHandler}.
 * @returns A Fastify `RouteHandlerMethod`.
 *
 * @example
 * ```ts
 * import Fastify from 'fastify';
 * import { createFastifyBulkHandler } from '@donotdev/restcrud/server/fastify';
 *
 * const app = Fastify();
 *
 * app.post(
 *   '/api/crud/:collection/bulk',
 *   createFastifyBulkHandler({
 *     entity: eventEntity,
 *     createSchema,
 *     updateSchema,
 *     access: { create: 'user', update: 'user', delete: 'user' },
 *     authenticate: async (req) => {
 *       const uid = req.headers['x-user-id'];
 *       if (typeof uid !== 'string') throw new Error('Missing x-user-id');
 *       return { uid, userRole: 'user' };
 *     },
 *     transact: async (prepared) => runPrismaTransaction(prepared),
 *   }),
 * );
 * ```
 *
 * @since 0.2.0
 */
export function createFastifyBulkHandler<TRow = unknown>(
  options: CreateBulkHandlerOptions<TRow>
): RouteHandlerMethod {
  const handle = createBulkHandler(options);

  return async function fastifyBulkHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const params = request.params as { collection?: string } | undefined;
    const collection = params?.collection;
    if (typeof collection !== 'string' || collection.length === 0) {
      reply.status(400).send({ error: 'Missing collection route parameter' });
      return;
    }

    const context: BulkRequestContext = {
      headers: request.headers,
      body: request.body,
      collection,
    };

    const payload = await handle(context);
    reply.status(payload.status).send(payload.body);
  };
}
