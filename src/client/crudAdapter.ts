// packages/providers/restcrud/src/client/crudAdapter.ts

/**
 * @fileoverview REST CRUD Adapter
 * @description ICrudAdapter implementation over plain JSON-over-HTTP. Collection
 * name = URL path segment. See README for the full protocol spec.
 *
 * **Architecture:**
 * - One class, no client SDK, just the global `fetch` API.
 * - Auth-agnostic — credentials/headers come from config, the server decides
 *   what to do with them. Default: `credentials: 'include'` so session cookies
 *   are forwarded.
 * - No field-name mapping. Whatever you send is whatever the server sees.
 * - No realtime subscribe — use polling via TanStack's `refetchInterval`.
 *
 * **Caching contract:**
 * This adapter is unaware of caching — CrudService owns TanStack Query entirely.
 * The adapter only fetches/writes; CrudService updates GET + list caches after
 * every mutation so the UI never refetches.
 *
 * @version 0.1.0
 * @since 0.0.1
 */

import * as v from 'valibot';

import type {
  BulkOperations,
  BulkResult,
  CollectionSubscriptionCallback,
  CrudOperationOptions,
  DocumentSubscriptionCallback,
  ICrudAdapter,
  PaginatedQueryResult,
  QueryOptions,
  dndevSchema,
} from '@donotdev/core';
import {
  BulkCollisionError,
  BulkRequestSchema,
  BulkResponseSchema,
  detectBulkCollisions,
  validateWithSchema,
  wrapCrudError,
} from '@donotdev/core';

import { buildQueryString } from '../common/queryBuilder';
import type {
  BeforeRequestHook,
  ListResponseTransform,
  PathResolver,
  RestCrudAdapterConfig,
} from '../common/types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = '/api/crud';
const DEFAULT_CREDENTIALS: RequestCredentials = 'include';

const defaultPathResolver: PathResolver = (baseUrl, collection, _op, id) => {
  const root = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(collection)}`;
  return id !== undefined ? `${root}/${encodeURIComponent(id)}` : root;
};

const defaultListTransform: ListResponseTransform = (raw) => {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj['data'])) {
      return {
        data: obj['data'] as unknown[],
        total:
          typeof obj['total'] === 'number'
            ? (obj['total'] as number)
            : undefined,
        nextCursor:
          typeof obj['nextCursor'] === 'string' || obj['nextCursor'] === null
            ? (obj['nextCursor'] as string | null)
            : undefined,
      };
    }
    // Legacy / alternative shapes
    if (Array.isArray(obj['items'])) {
      return {
        data: obj['items'] as unknown[],
        total:
          typeof obj['total'] === 'number'
            ? (obj['total'] as number)
            : undefined,
      };
    }
    if (Array.isArray(obj['results'])) {
      return {
        data: obj['results'] as unknown[],
        total:
          typeof obj['total'] === 'number'
            ? (obj['total'] as number)
            : undefined,
      };
    }
  }
  if (Array.isArray(raw)) return { data: raw };
  return { data: [] };
};

// ---------------------------------------------------------------------------
// RestCrudAdapter
// ---------------------------------------------------------------------------

export class RestCrudAdapter implements ICrudAdapter {
  /**
   * REST backends typically enforce auth/row-level scoping server-side, so
   * the framework's client-side visibility gate is redundant. We still run
   * schema validation on writes via `validateWithSchema` when the caller
   * provides one, but we do NOT filter fields on reads — the server is
   * the authoritative gate.
   */
  readonly dbLevelSecurity = true;

  private readonly baseUrl: string;
  private readonly credentials: RequestCredentials;
  private readonly baseHeaders: Record<string, string>;
  private readonly beforeRequest: BeforeRequestHook | undefined;
  private readonly pathResolver: PathResolver;
  private readonly listTransform: ListResponseTransform;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RestCrudAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.credentials = config.credentials ?? DEFAULT_CREDENTIALS;
    this.baseHeaders = { ...(config.headers ?? {}) };
    this.beforeRequest = config.beforeRequest;
    this.pathResolver = config.pathResolver ?? defaultPathResolver;
    this.listTransform = config.listResponseTransform ?? defaultListTransform;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildInit(
    method: string,
    body: unknown | undefined,
    collection: string,
    operation: string,
    id: string | undefined,
    signal: AbortSignal | undefined
  ): RequestInit & { headers: Headers } {
    const headers = new Headers(this.baseHeaders);
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    headers.set('accept', 'application/json');

    const init: RequestInit & { headers: Headers } = {
      method,
      headers,
      credentials: this.credentials,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;

    // The beforeRequest hook runs synchronously from the caller's viewpoint
    // but may be async; we await it in the call sites.
    (init as RequestInit & { __ctx: unknown }).__ctx = {
      collection,
      operation,
      id,
    };
    return init;
  }

  private async doFetch<T>(
    url: string,
    init: RequestInit & { headers: Headers },
    collection: string,
    operation: string,
    id?: string
  ): Promise<T> {
    if (this.beforeRequest) {
      await this.beforeRequest(init, { collection, operation, id });
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'RestCrudAdapter',
        operation,
        collection,
        id
      );
    }
    if (!res.ok) {
      // Try to parse { error, detail } JSON body; fall back to status text.
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string; detail?: string };
        if (body?.error || body?.detail) {
          message = [body.error, body.detail].filter(Boolean).join(': ');
        }
      } catch {
        // non-JSON body; keep the status text
      }
      throw wrapCrudError(
        new Error(message),
        'RestCrudAdapter',
        operation,
        collection,
        id
      );
    }
    if (res.status === 204) return undefined as unknown as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'RestCrudAdapter',
        operation,
        collection,
        id
      );
    }
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  async get<T>(
    collection: string,
    id: string,
    _schema?: dndevSchema<unknown>,
    options?: CrudOperationOptions
  ): Promise<T | null> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');
    const url = this.pathResolver(this.baseUrl, collection, 'get', id);
    const init = this.buildInit(
      'GET',
      undefined,
      collection,
      'get',
      id,
      options?.signal
    );
    try {
      const data = await this.doFetch<T & { id?: string }>(
        url,
        init,
        collection,
        'get',
        id
      );
      if (!data) return null;
      // Ensure id is present; trust server for everything else
      const out = {
        ...data,
        id: String((data as { id?: string }).id ?? id),
      } as T;
      return out;
    } catch (err) {
      // 404 should return null, not throw — detect via wrapped error message
      if (err instanceof Error && /\b404\b/.test(err.message)) return null;
      throw err;
    }
  }

  async query<T>(
    collection: string,
    options: QueryOptions,
    _schema?: dndevSchema<unknown>,
    _schemaType?: 'list' | 'listCard',
    operationOptions?: CrudOperationOptions
  ): Promise<PaginatedQueryResult<T>> {
    if (operationOptions?.signal?.aborted)
      throw new Error('Operation cancelled');
    const qs = buildQueryString(options);
    const url = this.pathResolver(this.baseUrl, collection, 'query') + qs;
    const init = this.buildInit(
      'GET',
      undefined,
      collection,
      'query',
      undefined,
      operationOptions?.signal
    );
    const raw = await this.doFetch<unknown>(url, init, collection, 'query');
    const envelope = this.listTransform(raw);
    const items = (envelope.data as Array<T & { id?: string }>).map((row) => ({
      ...row,
      id: String(row?.id ?? ''),
    })) as T[];
    const lastRow = items[items.length - 1] as
      | (T & { id?: string })
      | undefined;
    return {
      items,
      total: envelope.total,
      hasMore:
        envelope.nextCursor !== undefined && envelope.nextCursor !== null
          ? true
          : typeof envelope.total === 'number'
            ? items.length < envelope.total
            : false,
      lastVisible: envelope.nextCursor ?? String(lastRow?.id ?? ''),
    };
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  async add<T>(
    collection: string,
    data: T,
    schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');
    const validated = schema
      ? validateWithSchema(schema, data, 'RestCrudAdapter.add')
      : data;
    const url = this.pathResolver(this.baseUrl, collection, 'add');
    const init = this.buildInit(
      'POST',
      validated,
      collection,
      'add',
      undefined,
      options?.signal
    );
    const result = await this.doFetch<Record<string, unknown>>(
      url,
      init,
      collection,
      'add'
    );
    if (!result || typeof result !== 'object') {
      throw wrapCrudError(
        new Error('POST response missing body'),
        'RestCrudAdapter',
        'add',
        collection
      );
    }
    const id = String(result['id'] ?? '');
    return { id, data: { ...result, id } };
  }

  async set<T>(
    collection: string,
    id: string,
    data: T,
    schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');
    const validated = schema
      ? validateWithSchema(schema, data, 'RestCrudAdapter.set')
      : data;
    const url = this.pathResolver(this.baseUrl, collection, 'set', id);
    const init = this.buildInit(
      'PUT',
      validated,
      collection,
      'set',
      id,
      options?.signal
    );
    await this.doFetch<unknown>(url, init, collection, 'set', id);
  }

  async update<T>(
    collection: string,
    id: string,
    data: Partial<T>,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');
    const url = this.pathResolver(this.baseUrl, collection, 'update', id);
    const init = this.buildInit(
      'PATCH',
      data,
      collection,
      'update',
      id,
      options?.signal
    );
    await this.doFetch<unknown>(url, init, collection, 'update', id);
  }

  async delete(
    collection: string,
    id: string,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');
    const url = this.pathResolver(this.baseUrl, collection, 'delete', id);
    const init = this.buildInit(
      'DELETE',
      undefined,
      collection,
      'delete',
      id,
      options?.signal
    );
    await this.doFetch<unknown>(url, init, collection, 'delete', id);
  }

  /**
   * Bulk transactional operation.
   *
   * Wire contract: `POST ${baseUrl}/${collection}/bulk` with a
   * `BulkRequestSchema`-shaped body. The server runs every op in a single
   * transaction and returns a `BulkResponseSchema`-shaped summary. Auth
   * headers, `credentials`, and `beforeRequest` follow the same rules as
   * `add()`.
   *
   * Contract guarantees (server-enforced, mirrored client-side):
   *   1. Atomic — all ops commit or none do.
   *   2. Collision rejection — same id in `updates`+`deletes` or
   *      `inserts`+`updates` throws `BulkCollisionError` **before** any
   *      fetch. The collision error is re-thrown unwrapped so callers can
   *      `instanceof` it.
   *   3. Empty bulk (`{}`, or all-empty buckets) short-circuits to a zeroed
   *      result with no network call.
   *   4. Input order preserved per bucket in the returned ids.
   *
   * When `schema` is provided, each `inserts[i]` is validated via
   * `validateWithSchema` — same contract as `add()`. `updates[*].patch` is
   * not validated here because it is a partial view of the entity (mirrors
   * the single-row `update()`).
   *
   * @example
   * const result = await adapter.bulk('events', {
   *   inserts: [{ title: 'A' }],
   *   updates: [{ id: 'e1', patch: { title: 'renamed' } }],
   *   deletes: ['e2'],
   * }, eventSchema);
   * result.insertedIds; // ['evt_…']
   * result.updatedIds;  // ['e1']
   * result.deletedIds;  // ['e2']
   */
  async bulk<T extends Record<string, unknown>>(
    collection: string,
    ops: BulkOperations<T>,
    schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<BulkResult> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');

    const inserts = ops.inserts ?? [];
    const updates = ops.updates ?? [];
    const deletes = ops.deletes ?? [];

    // 1. Collision detection — reject ambiguous intent before any fetch.
    //    BulkCollisionError is re-thrown unwrapped so consumers can
    //    `instanceof` it regardless of which adapter produced it.
    const collision = detectBulkCollisions({
      inserts: inserts as Array<{ id?: string; [k: string]: unknown }>,
      updates: updates as Array<{ id: string; patch: unknown }>,
      deletes,
    });
    if (collision.where !== null) {
      throw new BulkCollisionError(collision.collisions, collision.where);
    }

    // 2. Empty short-circuit — no network call, zeroed result.
    if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
      return { insertedIds: [], updatedIds: [], deletedIds: [] };
    }

    // 3. Per-insert schema validation (mirrors add()). `validateWithSchema`
    //    throws a loud error that the caller surfaces directly — same
    //    contract as single-row add().
    const validatedInserts = schema
      ? inserts.map((row) =>
          validateWithSchema(schema, row, 'RestCrudAdapter.bulk')
        )
      : inserts;

    // 4. Build + validate the wire body at the boundary. Valibot failures
    //    propagate unwrapped — they indicate a programmer error the caller
    //    should see loud, not a silent 500.
    const wireBody = v.parse(BulkRequestSchema, {
      inserts: validatedInserts as Array<Record<string, unknown>>,
      updates: updates as Array<{ id: string; patch: Record<string, unknown> }>,
      deletes,
    });

    // 5. Fixed URL shape per wire contract — the server handler at
    //    `packages/functions/src/vercel/api/crud/bulk.ts` reads the
    //    collection from `${baseUrl}/${collection}/bulk`.
    const url = `${this.baseUrl}/${encodeURIComponent(collection)}/bulk`;
    const init = this.buildInit(
      'POST',
      wireBody,
      collection,
      'bulk',
      undefined,
      options?.signal
    );

    // 6. Transport + non-2xx → doFetch wraps via `wrapCrudError`,
    //    same as add()/set()/update()/delete(). JSON body parse errors are
    //    also wrapped there.
    const raw = await this.doFetch<unknown>(url, init, collection, 'bulk');

    // 7. Validate response at the boundary — guards against server drift.
    //    A malformed response surfaces as a loud valibot error; no silent
    //    fallback.
    return v.parse(BulkResponseSchema, raw);
  }

  // -------------------------------------------------------------------------
  // Subscribe — not implemented in v0.1
  // -------------------------------------------------------------------------

  subscribe?<T>(
    _collection: string,
    _id: string,
    _callback: DocumentSubscriptionCallback<T>,
    _schema?: dndevSchema<unknown>
  ): () => void {
    // No realtime. Use polling via TanStack's refetchInterval on the
    // calling hook. Return a no-op unsubscribe so callers don't crash.
    return () => {};
  }

  subscribeToCollection?<T>(
    _collection: string,
    _options: QueryOptions,
    _callback: CollectionSubscriptionCallback<T>,
    _schema?: dndevSchema<unknown>
  ): () => void {
    return () => {};
  }
}
