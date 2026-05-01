// packages/providers/restcrud/src/__tests__/server/bulkHandler.test.ts

/**
 * @fileoverview Tests for the framework-agnostic bulk handler factory.
 * @description Mocks `executeBulk` from `@donotdev/functions/shared` so we
 *   can assert the handler's status-code routing in isolation from the
 *   orchestrator's own behaviour (already covered by the functions package
 *   tests). Also covers the framework adapters at a smoke-test level: each
 *   adapter is imported and called with a synthetic request to confirm it
 *   extracts the correct `BulkRequestContext` and writes the response.
 *
 * @version 0.1.0
 * @since 0.2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkCollisionError } from '@donotdev/core';

// ---------------------------------------------------------------------------
// Mock executeBulk — every test wires up a per-call mock return.
// ---------------------------------------------------------------------------

const executeBulkMock = vi.fn();
vi.mock('@donotdev/functions/shared', () => ({
  executeBulk: (...args: unknown[]) => executeBulkMock(...args),
}));

// Import AFTER the mock so the handler binds to the mocked executeBulk.
import { createBulkHandler } from '../../server/bulkHandler';
import type {
  BulkRequestContext,
  CreateBulkHandlerOptions,
} from '../../server/bulkHandler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTITY = {
  collection: 'events',
  namespace: 'events',
  access: {
    create: 'user',
    update: 'user',
    delete: 'user',
    read: 'user',
  },
} as unknown as CreateBulkHandlerOptions['entity'];

const PASSTHROUGH_SCHEMA = {} as CreateBulkHandlerOptions['createSchema'];

const OK_RESPONSE = {
  insertedIds: ['new-1'],
  updatedIds: ['e1'],
  deletedIds: ['e2'],
};

function baseOptions(
  overrides: Partial<CreateBulkHandlerOptions> = {}
): CreateBulkHandlerOptions {
  return {
    entity: ENTITY,
    createSchema: PASSTHROUGH_SCHEMA,
    updateSchema: PASSTHROUGH_SCHEMA,
    access: { create: 'user', update: 'user', delete: 'user' },
    authenticate: async () => ({ uid: 'uid-1', userRole: 'user' }),
    transact: async () => ({ insertedIds: [], updatedIds: [], deletedIds: [] }),
    ...overrides,
  };
}

function makeContext(
  body: unknown,
  overrides: Partial<BulkRequestContext> = {}
): BulkRequestContext {
  return {
    headers: { authorization: 'Bearer token' },
    body,
    collection: 'events',
    ...overrides,
  };
}

const VALID_BODY = {
  inserts: [{ title: 'A' }],
  updates: [{ id: 'e1', patch: { title: 'renamed' } }],
  deletes: ['e2'],
};

// ---------------------------------------------------------------------------
// Tests — core handler
// ---------------------------------------------------------------------------

describe('createBulkHandler — core', () => {
  beforeEach(() => {
    executeBulkMock.mockReset();
  });

  it('returns 400 when body fails BulkRequestSchema', async () => {
    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext({ inserts: 'not-an-array' }));
    expect(payload.status).toBe(400);
    expect(payload.body).toHaveProperty('error');
    expect(String((payload.body as { error: string }).error)).toMatch(
      /Validation failed/
    );
    expect(executeBulkMock).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not an object', async () => {
    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext('nope'));
    expect(payload.status).toBe(400);
    expect(executeBulkMock).not.toHaveBeenCalled();
  });

  it('returns 401 when authenticate rejects', async () => {
    const handle = createBulkHandler(
      baseOptions({
        authenticate: async () => {
          throw new Error('Token expired');
        },
      })
    );
    const payload = await handle(makeContext(VALID_BODY));
    expect(payload.status).toBe(401);
    expect(payload.body).toEqual({ error: 'Token expired' });
    expect(executeBulkMock).not.toHaveBeenCalled();
  });

  it('returns 401 with generic message on non-Error rejection', async () => {
    const handle = createBulkHandler(
      baseOptions({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        authenticate: (() => Promise.reject('bad')) as any,
      })
    );
    const payload = await handle(makeContext(VALID_BODY));
    expect(payload.status).toBe(401);
    expect(payload.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 with the executeBulk response on happy path', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext(VALID_BODY));

    expect(payload.status).toBe(200);
    expect(payload.body).toEqual(OK_RESPONSE);
    expect(executeBulkMock).toHaveBeenCalledTimes(1);
  });

  it('forwards correct params to executeBulk', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const transact = vi.fn();
    const mintInsertId = () => 'minted-id';
    const stampInsertMetadata = (row: Record<string, unknown>) => ({ ...row });
    const stampUpdateMetadata = (patch: Record<string, unknown>) => ({
      ...patch,
    });
    const audit = vi.fn();

    const handle = createBulkHandler(
      baseOptions({
        authenticate: async () => ({ uid: 'uid-42', userRole: 'admin' }),
        transact,
        mintInsertId,
        stampInsertMetadata,
        stampUpdateMetadata,
        audit,
      })
    );

    await handle(makeContext(VALID_BODY));

    expect(executeBulkMock).toHaveBeenCalledTimes(1);
    const forwarded = executeBulkMock.mock.calls[0]![0];
    expect(forwarded.collection).toBe('events');
    expect(forwarded.uid).toBe('uid-42');
    expect(forwarded.userRole).toBe('admin');
    expect(forwarded.ops).toEqual(VALID_BODY);
    expect(forwarded.transact).toBe(transact);
    expect(forwarded.mintInsertId).toBe(mintInsertId);
    expect(forwarded.stampInsertMetadata).toBe(stampInsertMetadata);
    expect(forwarded.stampUpdateMetadata).toBe(stampUpdateMetadata);
    expect(forwarded.audit).toBe(audit);
    expect(forwarded.access).toEqual({
      create: 'user',
      update: 'user',
      delete: 'user',
    });
  });

  it('does not forward optional hooks when not provided', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const handle = createBulkHandler(baseOptions());
    await handle(makeContext(VALID_BODY));

    const forwarded = executeBulkMock.mock.calls[0]![0];
    expect(forwarded).not.toHaveProperty('mintInsertId');
    expect(forwarded).not.toHaveProperty('stampInsertMetadata');
    expect(forwarded).not.toHaveProperty('stampUpdateMetadata');
    expect(forwarded).not.toHaveProperty('audit');
  });

  it('returns 409 on BulkCollisionError', async () => {
    executeBulkMock.mockRejectedValueOnce(
      new BulkCollisionError(['a'], 'updates-deletes')
    );

    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext(VALID_BODY));

    expect(payload.status).toBe(409);
    expect(payload.body).toHaveProperty('error');
    expect(String((payload.body as { error: string }).error)).toMatch(
      /BulkCollisionError/
    );
  });

  it('returns 500 on any other error and does not leak stack', async () => {
    const err = new Error('boom');
    err.stack = 'Stack trace: secret internals';
    executeBulkMock.mockRejectedValueOnce(err);

    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext(VALID_BODY));

    expect(payload.status).toBe(500);
    expect(payload.body).toEqual({ error: 'boom' });
    // The body is exactly { error: message } — no `stack`, no `details`.
    expect(Object.keys(payload.body)).toEqual(['error']);
  });

  it('returns 500 with generic message on non-Error throw', async () => {
    executeBulkMock.mockRejectedValueOnce('string-throw');

    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext(VALID_BODY));

    expect(payload.status).toBe(500);
    expect(payload.body).toEqual({ error: 'Internal server error' });
  });

  it('accepts empty bulk bodies (executeBulk handles the short-circuit)', async () => {
    executeBulkMock.mockResolvedValueOnce({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });

    const handle = createBulkHandler(baseOptions());
    const payload = await handle(makeContext({}));

    expect(payload.status).toBe(200);
    expect(payload.body).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Smoke tests — framework adapters
//
// Each adapter is exercised once with a synthetic framework-native request
// to prove the context extraction works. Full framework integration tests
// live downstream in consumer repos — the heavy lifting is covered by the
// core handler tests above.
// ---------------------------------------------------------------------------

describe('adapter: express', () => {
  beforeEach(() => executeBulkMock.mockReset());

  it('extracts headers + body + collection and writes status/body', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const { createExpressBulkHandler } =
      await import('../../server/express');
    const handler = createExpressBulkHandler(baseOptions());

    const statusSpy = vi.fn().mockReturnThis();
    const jsonSpy = vi.fn();
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
      body: VALID_BODY,
      params: { collection: 'events' },
    };
    const res = { status: statusSpy, json: jsonSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, res as any, (() => {}) as any);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith(OK_RESPONSE);
  });

  it('405s non-POST methods', async () => {
    const { createExpressBulkHandler } =
      await import('../../server/express');
    const handler = createExpressBulkHandler(baseOptions());

    const statusSpy = vi.fn().mockReturnThis();
    const jsonSpy = vi.fn();
    const req = {
      method: 'GET',
      headers: {},
      body: {},
      params: { collection: 'x' },
    };
    const res = { status: statusSpy, json: jsonSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, res as any, (() => {}) as any);

    expect(statusSpy).toHaveBeenCalledWith(405);
    expect(executeBulkMock).not.toHaveBeenCalled();
  });
});

describe('adapter: hono', () => {
  beforeEach(() => executeBulkMock.mockReset());

  it('extracts headers + body + collection and returns a Response', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const { createHonoBulkHandler } = await import('../../server/hono');
    const handler = createHonoBulkHandler(baseOptions());

    const honoCtx = {
      req: {
        param: (name: string) => (name === 'collection' ? 'events' : undefined),
        json: async () => VALID_BODY,
        raw: { headers: new Headers({ authorization: 'Bearer t' }) },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(honoCtx as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_RESPONSE);
  });

  it('maps malformed JSON to 400', async () => {
    const { createHonoBulkHandler } = await import('../../server/hono');
    const handler = createHonoBulkHandler(baseOptions());

    const honoCtx = {
      req: {
        param: () => 'events',
        json: async () => {
          throw new Error('bad json');
        },
        raw: { headers: new Headers() },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(honoCtx as any);
    expect(res.status).toBe(400);
    expect(executeBulkMock).not.toHaveBeenCalled();
  });
});

describe('adapter: fastify', () => {
  beforeEach(() => executeBulkMock.mockReset());

  it('extracts headers + body + collection and writes via reply', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const { createFastifyBulkHandler } =
      await import('../../server/fastify');
    const handler = createFastifyBulkHandler(baseOptions());

    const statusSpy = vi.fn().mockReturnThis();
    const sendSpy = vi.fn();
    const request = {
      headers: { authorization: 'Bearer t' },
      body: VALID_BODY,
      params: { collection: 'events' },
    };
    const reply = { status: statusSpy, send: sendSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler.call({} as any, request as any, reply as any);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(sendSpy).toHaveBeenCalledWith(OK_RESPONSE);
  });
});

describe('adapter: next (App Router)', () => {
  beforeEach(() => executeBulkMock.mockReset());

  it('handles sync params and returns a Response', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const { createNextAppBulkHandler } = await import('../../server/next');
    const handler = createNextAppBulkHandler(baseOptions());

    const req = {
      headers: new Headers({ authorization: 'Bearer t' }),
      json: async () => VALID_BODY,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(req as any, { params: { collection: 'events' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_RESPONSE);
  });

  it('awaits async params (Next 15+)', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const { createNextAppBulkHandler } = await import('../../server/next');
    const handler = createNextAppBulkHandler(baseOptions());

    const req = {
      headers: new Headers(),
      json: async () => VALID_BODY,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await handler(req as any, {
      params: Promise.resolve({ collection: 'events' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('adapter: next (Pages Router)', () => {
  beforeEach(() => executeBulkMock.mockReset());

  it('extracts collection from req.query and writes via res.status/json', async () => {
    executeBulkMock.mockResolvedValueOnce(OK_RESPONSE);

    const { createNextPagesBulkHandler } = await import('../../server/next');
    const handler = createNextPagesBulkHandler(baseOptions());

    const statusSpy = vi.fn().mockReturnThis();
    const jsonSpy = vi.fn();
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
      body: VALID_BODY,
      query: { collection: 'events' },
    };
    const res = { status: statusSpy, json: jsonSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, res as any);

    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith(OK_RESPONSE);
  });

  it('405s non-POST methods', async () => {
    const { createNextPagesBulkHandler } = await import('../../server/next');
    const handler = createNextPagesBulkHandler(baseOptions());

    const statusSpy = vi.fn().mockReturnThis();
    const jsonSpy = vi.fn();
    const req = {
      method: 'DELETE',
      headers: {},
      body: {},
      query: { collection: 'events' },
    };
    const res = { status: statusSpy, json: jsonSpy };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(req as any, res as any);
    expect(statusSpy).toHaveBeenCalledWith(405);
    expect(executeBulkMock).not.toHaveBeenCalled();
  });
});
