// packages/providers/restcrud/src/server/index.ts

/**
 * @fileoverview Server barrel for the framework-agnostic bulk handler.
 * @description Re-exports ONLY the core `createBulkHandler` + its types.
 *   Framework adapters (express / hono / fastify / next) are intentionally
 *   NOT in this barrel so consumers who import `@donotdev/restcrud/server`
 *   don't accidentally pull any framework's type declarations into their
 *   build. Import adapters explicitly via their subpaths:
 *
 *   - `@donotdev/restcrud/server/express`
 *   - `@donotdev/restcrud/server/hono`
 *   - `@donotdev/restcrud/server/fastify`
 *   - `@donotdev/restcrud/server/next`
 *
 * @version 0.1.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

export { createBulkHandler } from './bulkHandler';
export type {
  BulkRequestContext,
  BulkResponsePayload,
  CreateBulkHandlerOptions,
} from './bulkHandler';
