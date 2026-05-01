# @donotdev/restcrud

REST CRUD provider for DoNotDev — plain JSON-over-HTTP adapter for self-hosted backends (bun/Hono, Express, Fastify, Go, Rails, anything that speaks RESTful JSON).

Drop it in when your app talks to its own backend instead of Firebase or Supabase. Same `ICrudAdapter` contract as every other provider, so `EntityList` / `EntityForm` / `EntityDetail` / `useCrudList` all just work.

## Install

```sh
bun add @donotdev/restcrud
# or
npm i @donotdev/restcrud
```

No runtime deps — the adapter uses the global `fetch` API. Peer-depends on `@donotdev/core`.

## Use

```ts
import { configureProviders } from '@donotdev/core';
import { RestCrudAdapter } from '@donotdev/restcrud';

configureProviders({
  crud: new RestCrudAdapter({
    baseUrl: '/api/crud',        // default: '/api/crud'
    credentials: 'include',      // default: 'include' — send session cookies
  }),
});
```

Then define an entity and render it:

```tsx
import { defineEntity } from '@donotdev/core';
import { EntityList } from '@donotdev/ui';

const memoryEntity = defineEntity({
  collection: 'memories',
  namespace: 'memoires',
  fields: {
    content: { type: 'text', label: 'Contenu' },
    category: { type: 'select', options: ['fact', 'preference', 'medical', 'correction'] },
    topic: { type: 'text' },
    createdAt: { type: 'date' },
  },
  listFields: ['category', 'topic', 'content', 'createdAt'],
});

export function MemoriesPage() {
  return <EntityList entity={memoryEntity} basePath="/memoires" />;
}
```

## Protocol

The adapter assumes a classic RESTful JSON API. Every collection is served at `${baseUrl}/${collection}` with these operations:

| Adapter method          | HTTP             | Path                         | Request body            | Response body                                       |
|-------------------------|------------------|------------------------------|-------------------------|-----------------------------------------------------|
| `get(coll, id)`         | `GET`            | `/${coll}/${id}`             | —                       | `{ id, ...fields }` or `404`                        |
| `query(coll, opts)`     | `GET`            | `/${coll}?${query}`          | —                       | `{ data: [...], total?, nextCursor? }`              |
| `add(coll, data)`       | `POST`           | `/${coll}`                   | `{ ...fields }`         | `{ id, ...fields }`                                 |
| `set(coll, id, data)`   | `PUT`            | `/${coll}/${id}`             | `{ ...fields }`         | `{ id, ...fields }`                                 |
| `update(coll, id, p)`   | `PATCH`          | `/${coll}/${id}`             | `{ ...partialFields }`  | `{ id, ...fields }`                                 |
| `delete(coll, id)`      | `DELETE`         | `/${coll}/${id}`             | —                       | `204 No Content` or `{ ok: true }`                  |
| `bulk(coll, ops)`       | `POST`           | `/${coll}/bulk`              | `BulkRequestSchema`     | `BulkResponseSchema` — `{ insertedIds, updatedIds, deletedIds }` |

`bulk()` is transactional: the server runs one DB transaction and all ops either commit together or roll back together. An empty body `{}` short-circuits to `{ insertedIds: [], updatedIds: [], deletedIds: [] }` without hitting the DB. Id collisions (same id in `updates` + `deletes`, or `inserts` + `updates`) reject with `400` before any write. See `@donotdev/schemas` for the full wire schemas.

### Query-string schema

`query()` translates the `QueryOptions` shape into URL-safe parameters:

```
?limit=20
&offset=0
&orderBy=createdAt:desc
&orderBy=topic:asc
&where[category][eq]=preference
&where[ownerId][eq]=abc-123
&where[createdAt][gte]=2026-01-01
&where[id][in]=a,b,c
```

Supported operators (v0.1):

| Operator         | Query key                             |
|------------------|---------------------------------------|
| `==`             | `where[field][eq]=value`              |
| `!=`             | `where[field][neq]=value`             |
| `<`              | `where[field][lt]=value`              |
| `<=`             | `where[field][lte]=value`             |
| `>`              | `where[field][gt]=value`              |
| `>=`             | `where[field][gte]=value`             |
| `in`             | `where[field][in]=a,b,c`              |
| `array-contains` | `where[field][contains]=value`        |

Rare operators (`array-contains-any`, full-text search) are out of scope for v0.1 — add a custom `pathResolver` or a higher-level entity method if you need them.

### Errors

Non-2xx responses are wrapped via `wrapCrudError` from `@donotdev/core`:

```json
{ "error": "not_found", "detail": "memory 42 does not exist" }
```

The adapter reads `error` and `detail` if present, falls back to the HTTP status text otherwise.

## Authentication

The adapter is auth-agnostic — it just forwards credentials and lets the server decide. The default `credentials: 'include'` sends cookies on every request; pair it with a session-cookie middleware on the server. Bearer-token auth works too: pass a custom `headers` object or wrap `fetch` with an interceptor.

## Subscribe

Realtime `subscribe()` and `subscribeToCollection()` are **not** implemented in v0.1. Use TanStack Query's `refetchInterval` or `refetchOnWindowFocus` for polling fallback.

A future version may add WebSocket or Server-Sent Events support via an opt-in transport.

## Server — bulk handler

The client adapter's `bulk()` method ships work in a single round-trip and expects the server to commit every op atomically. On Vercel + Firebase admin, `@donotdev/functions/vercel` already provides a ready-made route handler. For every other stack (Express, Hono, Fastify, self-hosted Next.js, Bun, Cloudflare Workers), `@donotdev/restcrud/server` ships a framework-agnostic factory you wire up with ~10 lines.

### Why you want atomic bulk

- One round-trip instead of N. Matters at 20+ ops per action.
- Either everything commits or nothing does. No half-written inserts + partial updates.
- Collision detection (same id in two buckets) rejects before any write.
- Empty payloads short-circuit with no DB touch.

### Core factory — framework-agnostic

```ts
import { createBulkHandler } from '@donotdev/restcrud/server';

const handle = createBulkHandler({
  entity: eventEntity,                   // from defineEntity()
  createSchema: eventCreateSchema,       // from createSchemas()
  updateSchema: eventUpdateSchema,
  access: { create: 'user', update: 'user', delete: 'user' },
  // Resolve { uid, userRole } from the inbound request — throw to 401.
  authenticate: async (req) => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') throw new Error('Missing bearer token');
    const claims = await verifyJwt(header.replace(/^Bearer /, ''));
    return { uid: claims.sub, userRole: claims.role ?? 'user' };
  },
  // Run all three buckets inside ONE atomic transaction.
  transact: async ({ inserts, updates, deletes }) => {
    return db.transaction(async (tx) => {
      for (const { id, row } of inserts) await tx.insert(events).values({ id, ...row });
      for (const { id, patch } of updates) await tx.update(events).set(patch).where(eq(events.id, id));
      for (const id of deletes) await tx.delete(events).where(eq(events.id, id));
      return {
        insertedIds: inserts.map((i) => i.id),
        updatedIds: updates.map((u) => u.id),
        deletedIds: [...deletes],
      };
    });
  },
});

// handle is (req) => Promise<{ status, body }>
```

Status codes:

| Code | When |
|------|------|
| `200` | Success — body is `{ insertedIds, updatedIds, deletedIds }`. |
| `400` | Body failed `BulkRequestSchema` (malformed wire payload). |
| `401` | `authenticate()` rejected. Body is `{ error: <message> }`. |
| `409` | `BulkCollisionError` — same id in two mutually-exclusive buckets. |
| `500` | Anything else. Body is `{ error: <message> }` — never a stack. |

### Express

```ts
import express from 'express';
import { createExpressBulkHandler } from '@donotdev/restcrud/server/express';

const app = express();
app.use(express.json());

app.post(
  '/api/crud/:collection/bulk',
  createExpressBulkHandler({
    entity: eventEntity,
    createSchema,
    updateSchema,
    access: { create: 'user', update: 'user', delete: 'user' },
    authenticate: async (req) => resolveFromCookie(req.headers['cookie']),
    transact: async (prepared) => runPrismaTransaction(prepared),
  }),
);
```

### Hono

```ts
import { Hono } from 'hono';
import { createHonoBulkHandler } from '@donotdev/restcrud/server/hono';

const app = new Hono();

app.post(
  '/api/crud/:collection/bulk',
  createHonoBulkHandler({
    entity: eventEntity,
    createSchema,
    updateSchema,
    access: { create: 'user', update: 'user', delete: 'user' },
    authenticate: async (req) => {
      const header = req.headers['authorization'];
      if (typeof header !== 'string') throw new Error('Missing bearer');
      return verifyJwt(header.replace(/^Bearer /, ''));
    },
    transact: async (prepared) => runDrizzleTransaction(prepared),
  }),
);

export default app;
```

Works on Node, Bun, Deno, and Cloudflare Workers — Hono's runtime abstraction passes straight through.

### Fastify

```ts
import Fastify from 'fastify';
import { createFastifyBulkHandler } from '@donotdev/restcrud/server/fastify';

const app = Fastify();

app.post(
  '/api/crud/:collection/bulk',
  createFastifyBulkHandler({
    entity: eventEntity,
    createSchema,
    updateSchema,
    access: { create: 'user', update: 'user', delete: 'user' },
    authenticate: async (req) => app.jwt.verify(req.headers['authorization']),
    transact: async (prepared) => runPrismaTransaction(prepared),
  }),
);
```

### Next.js — App Router

```ts
// app/api/crud/[collection]/bulk/route.ts
import { createNextAppBulkHandler } from '@donotdev/restcrud/server/next';

export const POST = createNextAppBulkHandler({
  entity: eventEntity,
  createSchema,
  updateSchema,
  access: { create: 'user', update: 'user', delete: 'user' },
  authenticate: async (req) => resolveSession(req.headers['cookie']),
  transact: async (prepared) => runDrizzleTransaction(prepared),
});
```

### Next.js — Pages Router

```ts
// pages/api/crud/[collection]/bulk.ts
import { createNextPagesBulkHandler } from '@donotdev/restcrud/server/next';

export default createNextPagesBulkHandler({
  entity: eventEntity,
  createSchema,
  updateSchema,
  access: { create: 'user', update: 'user', delete: 'user' },
  authenticate: async (req) => resolveSession(req.headers['cookie']),
  transact: async (prepared) => runPrismaTransaction(prepared),
});
```

### Supplying `authenticate` + `transact`

**`authenticate`** — receives the parsed request context and returns `{ uid, userRole }` or throws. Shape examples:

```ts
// Cookie-session (Express + express-session)
authenticate: async (req) => {
  const sid = parseCookie(req.headers['cookie'])?.['sid'];
  if (!sid) throw new Error('No session');
  const session = await redis.get(`sess:${sid}`);
  if (!session) throw new Error('Session expired');
  return { uid: session.uid, userRole: session.role };
}

// Bearer JWT (Hono / Cloudflare Workers)
authenticate: async (req) => {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') throw new Error('Missing bearer');
  const claims = await jose.jwtVerify(auth.replace(/^Bearer /, ''), secret);
  return { uid: claims.payload.sub!, userRole: claims.payload.role as UserRole };
}
```

**`transact`** — receives `{ inserts, updates, deletes }` where inserts carry their minted id (or `''` if you didn't supply `mintInsertId`). Must wrap all three buckets in ONE atomic transaction. Gestures per driver:

```ts
// Prisma
transact: async ({ inserts, updates, deletes }) =>
  prisma.$transaction(async (tx) => {
    for (const { id, row } of inserts) await tx.event.create({ data: { id, ...row } });
    for (const { id, patch } of updates) await tx.event.update({ where: { id }, data: patch });
    for (const id of deletes) await tx.event.delete({ where: { id } });
    return {
      insertedIds: inserts.map((i) => i.id),
      updatedIds: updates.map((u) => u.id),
      deletedIds: [...deletes],
    };
  })

// Raw pg
transact: async ({ inserts, updates, deletes }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ...run inserts / updates / deletes against client...
    await client.query('COMMIT');
    return { insertedIds, updatedIds, deletedIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Drizzle
transact: async (prepared) =>
  db.transaction(async (tx) => {
    // ...Drizzle inserts / updates / deletes on `tx`...
    return { insertedIds, updatedIds, deletedIds };
  })
```

The shared orchestrator `executeBulk` (in `@donotdev/functions/shared`) owns collision detection, per-bucket ACL, per-row validation, id minting, metadata stamping, atomic dispatch, and response-shape validation. See [`@donotdev/functions` docs](../../functions/README.md) for the full contract.

## Field mapping

The adapter does **not** mangle field names. Whatever you send is whatever the server sees. If your backend uses snake_case and your entity uses camelCase, either normalise on the server or wrap the adapter with a custom mapper.

## License

See [LICENSE.md](./LICENSE.md).
