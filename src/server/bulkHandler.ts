// packages/providers/restcrud/src/server/bulkHandler.ts

/**
 * @fileoverview Framework-agnostic bulk CRUD request handler.
 * @description Core factory that turns consumer-supplied adapters (auth,
 *   transact, metadata stamping) into a request-agnostic async function
 *   `(BulkRequestContext) => Promise<BulkResponsePayload>`. The four
 *   framework adapters in this directory (express / hono / fastify / next)
 *   wrap this core with ~30 lines that extract headers / body / collection
 *   from the framework-native request type, then call the core and write
 *   the response back in the framework-native way.
 *
 *   Mirrors the Vercel handler at
 *   `packages/functions/src/vercel/api/crud/bulk.ts` — same status codes,
 *   same wire body, same collision semantics. The difference is that the
 *   Vercel handler owns its own auth (`verifyAuthToken`) and transact
 *   (firebase-admin) because it's targeting a single platform; this core
 *   pushes both out to the consumer because a Hono handler running on
 *   Cloudflare Workers has neither firebase-admin nor Next's cookies().
 *
 *   Status code contract:
 *   - 200 — happy path, body is {@link BulkResponse}.
 *   - 400 — body failed {@link BulkRequestSchema}.
 *   - 401 — `authenticate()` rejected (threw or returned a rejection).
 *   - 409 — {@link BulkCollisionError} thrown by executeBulk.
 *   - 500 — anything else, message only, no stack.
 *
 * @version 0.1.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { BulkCollisionError, BulkRequestSchema } from '@donotdev/core/server';
import type {
  BulkRequest,
  BulkResponse,
  dndevSchema,
  Entity,
  EntityAccessConfig,
  UserRole,
} from '@donotdev/core/server';
import { executeBulk } from '@donotdev/functions/shared';
import type { ExecuteBulkParams } from '@donotdev/functions/shared';

// ---------------------------------------------------------------------------
// Request / response context
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic request context passed to the core handler. Each
 * adapter is responsible for extracting this from its native request type.
 *
 * @since 0.2.0
 */
export interface BulkRequestContext {
  /**
   * Inbound request headers. Shape matches Node's `IncomingHttpHeaders`
   * (lower-cased keys, values may be `string | string[] | undefined`) so
   * every framework's headers object maps cleanly without normalisation.
   */
  headers: Record<string, string | string[] | undefined>;
  /**
   * Parsed JSON body. Adapters MUST parse the raw body before invoking the
   * handler — the core never reads streams. `undefined` and non-objects
   * are rejected by {@link BulkRequestSchema}.
   */
  body: unknown;
  /**
   * Collection name extracted from the URL segment. Consumer-extracted
   * because URL routing is framework-specific (`req.params.collection` in
   * Express, `c.req.param('collection')` in Hono, `params.collection` in
   * Next's App Router handler, etc.).
   */
  collection: string;
}

/**
 * Framework-agnostic response shape. Adapters map `status` + `body` to
 * their native response type.
 *
 * @since 0.2.0
 */
export interface BulkResponsePayload {
  /** HTTP status code. See file-level docs for the code contract. */
  status: number;
  /** JSON-serialisable response body. */
  body: BulkResponse | { error: string };
}

// ---------------------------------------------------------------------------
// Handler factory options
// ---------------------------------------------------------------------------

/**
 * Options for {@link createBulkHandler}.
 *
 * @template TRow - Row type for the entity (documentation only; runtime is
 *   opaque because the wire schemas are structural).
 *
 * @since 0.2.0
 */
export interface CreateBulkHandlerOptions<TRow = unknown> {
  /**
   * Entity metadata. Currently only `collection` is consulted on the
   * server — kept as a full Entity so future additions (audit hook names,
   * soft-delete flags) don't break the signature.
   */
  entity: Entity;
  /** Valibot schema validating each insert row. */
  createSchema: dndevSchema<TRow>;
  /** Valibot schema validating each update patch. */
  updateSchema: dndevSchema<Partial<TRow>>;
  /** Per-bucket required roles. Forwarded to `executeBulk`. */
  access: EntityAccessConfig;
  /**
   * Resolve `{ uid, userRole }` from the inbound request. Consumer-supplied
   * because every REST stack has a different auth layer:
   *  - cookie-session middleware (Express + express-session)
   *  - Bearer JWT (Hono + jose)
   *  - Next.js server-side `cookies()` + DB lookup
   *  - Fastify + @fastify/jwt
   *
   * Throw (or return a rejected promise) to deny access — the core maps
   * any rejection to `401 Unauthorized` with the error's message.
   */
  authenticate: (
    req: BulkRequestContext
  ) => Promise<{ uid: string; userRole: UserRole }>;
  /**
   * Target-specific storage — same contract as `executeBulk`'s `transact`.
   * Must run all three buckets inside one atomic transaction.
   */
  transact: ExecuteBulkParams['transact'];
  /** Optional id minting. See {@link ExecuteBulkParams.mintInsertId}. */
  mintInsertId?: ExecuteBulkParams['mintInsertId'];
  /** Optional insert metadata hook. */
  stampInsertMetadata?: ExecuteBulkParams['stampInsertMetadata'];
  /** Optional update metadata hook. */
  stampUpdateMetadata?: ExecuteBulkParams['stampUpdateMetadata'];
  /** Optional audit hook fired once on success with the three op counts. */
  audit?: ExecuteBulkParams['audit'];
}

// ---------------------------------------------------------------------------
// Core factory
// ---------------------------------------------------------------------------

/**
 * Build a framework-agnostic bulk handler for one entity. The returned
 * function is pure with respect to the inbound request — it parses the
 * body, authenticates, runs `executeBulk`, and returns a
 * {@link BulkResponsePayload} the adapter writes back.
 *
 * Error classification:
 *  - {@link BulkRequestSchema} failure → 400.
 *  - `authenticate()` rejection → 401.
 *  - {@link BulkCollisionError} → 409.
 *  - Any other thrown value → 500 with `err.message` only (no stack).
 *
 * The handler never throws — every error path returns a payload. This
 * keeps adapters trivial (no try/catch around the call).
 *
 * @template TRow - Entity row type.
 * @param options - Handler configuration.
 * @returns A request-agnostic handler.
 *
 * @example
 * ```ts
 * import { createBulkHandler } from '@donotdev/restcrud/server';
 *
 * const handle = createBulkHandler({
 *   entity: eventEntity,
 *   createSchema: eventCreateSchema,
 *   updateSchema: eventUpdateSchema,
 *   access: { create: 'user', update: 'user', delete: 'user' },
 *   authenticate: async (req) => {
 *     const token = req.headers['authorization'];
 *     if (typeof token !== 'string') throw new Error('Missing bearer token');
 *     return verifyJwt(token.replace(/^Bearer /, ''));
 *   },
 *   transact: async ({ inserts, updates, deletes }) => {
 *     return db.transaction(async (tx) => {
 *       for (const { id, row } of inserts) await tx.insert(events).values({ id, ...row });
 *       for (const { id, patch } of updates) await tx.update(events).set(patch).where(eq(events.id, id));
 *       for (const id of deletes) await tx.delete(events).where(eq(events.id, id));
 *       return {
 *         insertedIds: inserts.map((i) => i.id),
 *         updatedIds: updates.map((u) => u.id),
 *         deletedIds: [...deletes],
 *       };
 *     });
 *   },
 * });
 *
 * const payload = await handle({ headers, body, collection: 'events' });
 * ```
 *
 * @since 0.2.0
 */
export function createBulkHandler<TRow = unknown>(
  options: CreateBulkHandlerOptions<TRow>
): (req: BulkRequestContext) => Promise<BulkResponsePayload> {
  const {
    entity,
    createSchema,
    updateSchema,
    access,
    authenticate,
    transact,
    mintInsertId,
    stampInsertMetadata,
    stampUpdateMetadata,
    audit,
  } = options;

  return async function handle(
    req: BulkRequestContext
  ): Promise<BulkResponsePayload> {
    // 1. Structural wire-schema validation. Intercepted here so malformed
    //    bodies surface as a stable 400 with the wire shape `{ error }` that
    //    REST clients already expect — matches the Vercel handler.
    const parseResult = v.safeParse(BulkRequestSchema, req.body);
    if (!parseResult.success) {
      return {
        status: 400,
        body: {
          error: `Validation failed: ${parseResult.issues
            .map((issue) => issue.message)
            .join(', ')}`,
        },
      };
    }
    const ops: BulkRequest = parseResult.output;

    // 2. Authentication. Any rejection — thrown or returned — becomes a 401.
    //    We intentionally surface the auth error's message so consumers can
    //    signal reason codes ("Token expired", "Revoked", etc.). Stack is
    //    not forwarded.
    let auth: { uid: string; userRole: UserRole };
    try {
      auth = await authenticate(req);
    } catch (err) {
      return {
        status: 401,
        body: { error: err instanceof Error ? err.message : 'Unauthorized' },
      };
    }

    // 3. Delegate to the shared orchestrator. executeBulk owns collision
    //    detection, per-bucket ACL, per-row validation, metadata stamping,
    //    atomic dispatch, and response-shape validation.
    try {
      const response = await executeBulk({
        collection: entity.collection,
        ops,
        createSchema,
        updateSchema,
        access,
        uid: auth.uid,
        userRole: auth.userRole,
        transact,
        ...(mintInsertId ? { mintInsertId } : {}),
        ...(stampInsertMetadata ? { stampInsertMetadata } : {}),
        ...(stampUpdateMetadata ? { stampUpdateMetadata } : {}),
        ...(audit ? { audit } : {}),
      });
      return { status: 200, body: response };
    } catch (err) {
      // 4a. Collision → 409 Conflict. Mirrors the client-side contract:
      //     `BulkCollisionError` is a caller-facing problem, not a server
      //     fault. The Vercel handler chose 400 because its legacy tests
      //     were wired that way; new-build consumers get the more precise
      //     409 which matches HTTP semantics for "request conflicts with
      //     current state" and lets browsers retry-idempotently cleanly.
      if (err instanceof BulkCollisionError) {
        return { status: 409, body: { error: err.message } };
      }
      // 4b. Anything else → 500 with message only. We do NOT expose the
      //     stack — consumers who need richer diagnostics wire their own
      //     logger around `transact` or `audit`.
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      return { status: 500, body: { error: message } };
    }
  };
}
