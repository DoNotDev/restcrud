// packages/providers/restcrud/src/__tests__/crudAdapter.bulk.test.ts

/**
 * @fileoverview RestCrudAdapter.bulk() — transport + wire-shape tests
 * @description Verifies the REST client's `bulk()` method matches the server
 *   contract at `packages/functions/src/vercel/api/crud/bulk.ts`. Mocks
 *   `fetch` — no network. Covers:
 *     - URL + method + body shape vs `BulkRequestSchema`.
 *     - Empty bulk short-circuit (no fetch).
 *     - Collision rejection (no fetch, `BulkCollisionError` unwrapped).
 *     - Non-2xx surfaces as a wrapped CRUD error (mirrors `add()`).
 *     - Malformed response surfaces as a loud Valibot error.
 *     - Network rejection surfaces as a wrapped CRUD error.
 *     - Auth headers + `credentials` mirror how `add()` sends requests.
 *
 * @version 0.1.0
 * @since 0.2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkCollisionError } from '@donotdev/core';

import { RestCrudAdapter } from '../client/crudAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = 'https://api.example.test/crud';
const COLLECTION = 'events';
const BULK_URL = `${BASE}/${COLLECTION}/bulk`;

type FetchMock = ReturnType<typeof vi.fn>;

function mockJsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockRawResponse(
  body: string,
  init: { status?: number; contentType?: string } = {}
) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
}

function makeAdapter(
  fetchMock: FetchMock,
  headers: Record<string, string> = {}
) {
  return new RestCrudAdapter({
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RestCrudAdapter.bulk()', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('POSTs BulkRequestSchema-shaped body to ${baseUrl}/${collection}/bulk and passes through the response', async () => {
    const serverBody = {
      insertedIds: ['new-1'],
      updatedIds: ['e1'],
      deletedIds: ['e2'],
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(serverBody));

    const adapter = makeAdapter(fetchMock);
    const result = await adapter.bulk(COLLECTION, {
      inserts: [{ title: 'A' }],
      updates: [{ id: 'e1', patch: { title: 'renamed' } }],
      deletes: ['e2'],
    });

    expect(result).toEqual(serverBody);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Headers },
    ];
    expect(calledUrl).toBe(BULK_URL);
    expect(calledInit.method).toBe('POST');

    // Body matches BulkRequestSchema exactly.
    expect(typeof calledInit.body).toBe('string');
    const parsed = JSON.parse(calledInit.body as string);
    expect(parsed).toEqual({
      inserts: [{ title: 'A' }],
      updates: [{ id: 'e1', patch: { title: 'renamed' } }],
      deletes: ['e2'],
    });
  });

  it('URL-encodes the collection segment', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ insertedIds: [], updatedIds: [], deletedIds: [] })
    );

    const adapter = makeAdapter(fetchMock);
    await adapter.bulk('weird/name', { deletes: ['a'] });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe(`${BASE}/weird%2Fname/bulk`);
  });

  it('short-circuits an empty bulk — no fetch call, zeroed result', async () => {
    const adapter = makeAdapter(fetchMock);

    const r1 = await adapter.bulk(COLLECTION, {});
    const r2 = await adapter.bulk(COLLECTION, {
      inserts: [],
      updates: [],
      deletes: [],
    });

    expect(r1).toEqual({ insertedIds: [], updatedIds: [], deletedIds: [] });
    expect(r2).toEqual({ insertedIds: [], updatedIds: [], deletedIds: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects updates+deletes collision with BulkCollisionError (unwrapped, no fetch)', async () => {
    const adapter = makeAdapter(fetchMock);

    await expect(
      adapter.bulk(COLLECTION, {
        updates: [{ id: 'a', patch: { title: 'x' } }],
        deletes: ['a'],
      })
    ).rejects.toBeInstanceOf(BulkCollisionError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects inserts+updates collision with BulkCollisionError (unwrapped, no fetch)', async () => {
    const adapter = makeAdapter(fetchMock);

    // Inserts carry an explicit id here to trigger the inserts-updates pair.
    await expect(
      adapter.bulk(COLLECTION, {
        inserts: [{ id: 'a', title: 'x' } as unknown as { id?: string }],
        updates: [{ id: 'a', patch: { title: 'y' } }],
      })
    ).rejects.toBeInstanceOf(BulkCollisionError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wraps a 500 response as a CRUD error with status + body', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ error: 'boom', detail: 'db down' }, { status: 500 })
    );

    const adapter = makeAdapter(fetchMock);
    await expect(
      adapter.bulk(COLLECTION, { deletes: ['x'] })
    ).rejects.toMatchObject({ message: expect.stringContaining('boom') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a malformed JSON response as a loud Valibot error', async () => {
    // 200 OK but the body is missing the required id arrays → response schema parse fails.
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ not: 'a bulk response' })
    );

    const adapter = makeAdapter(fetchMock);
    await expect(
      adapter.bulk(COLLECTION, { deletes: ['x'] })
    ).rejects.toThrow();
  });

  it('surfaces a non-JSON 200 as a wrapped error (doFetch JSON parse)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRawResponse('<html>not json</html>', { contentType: 'text/html' })
    );

    const adapter = makeAdapter(fetchMock);
    await expect(
      adapter.bulk(COLLECTION, { deletes: ['x'] })
    ).rejects.toThrow();
  });

  it('wraps a network error as a CRUD error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const adapter = makeAdapter(fetchMock);
    await expect(adapter.bulk(COLLECTION, { deletes: ['x'] })).rejects.toThrow(
      /Failed to fetch/
    );
  });

  it('sends the same auth headers and credentials as add()', async () => {
    // Two calls on the same adapter: one add(), one bulk(). The init passed
    // to fetch should share the auth header and `credentials` mode.
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ id: 'new-id', title: 'A' })) // add
      .mockResolvedValueOnce(
        mockJsonResponse({ insertedIds: [], updatedIds: [], deletedIds: ['x'] })
      ); // bulk

    const adapter = makeAdapter(fetchMock, { authorization: 'Bearer tok-123' });

    await adapter.add(COLLECTION, { title: 'A' });
    await adapter.bulk(COLLECTION, { deletes: ['x'] });

    const [, addInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Headers },
    ];
    const [, bulkInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit & { headers: Headers },
    ];

    // credentials defaults to 'include' on both.
    expect(addInit.credentials).toBe('include');
    expect(bulkInit.credentials).toBe('include');

    // Same auth + content-type on both requests.
    expect(addInit.headers.get('authorization')).toBe('Bearer tok-123');
    expect(bulkInit.headers.get('authorization')).toBe('Bearer tok-123');
    expect(addInit.headers.get('content-type')).toBe('application/json');
    expect(bulkInit.headers.get('content-type')).toBe('application/json');
    expect(addInit.headers.get('accept')).toBe('application/json');
    expect(bulkInit.headers.get('accept')).toBe('application/json');

    // Both are POST.
    expect(addInit.method).toBe('POST');
    expect(bulkInit.method).toBe('POST');
  });

  it('forwards an abort signal and rejects pre-fetch when already aborted', async () => {
    const adapter = makeAdapter(fetchMock);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      adapter.bulk(COLLECTION, { deletes: ['x'] }, undefined, {
        signal: ctrl.signal,
      })
    ).rejects.toThrow(/cancelled/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
