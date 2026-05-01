// packages/providers/restcrud/src/common/types.ts

/**
 * @fileoverview Public types for the REST CRUD adapter.
 *
 * @version 0.1.0
 * @since 0.0.1
 */

/**
 * Per-request hook that lets consumers mutate the `Request` before it's
 * dispatched (e.g. inject a Bearer token, add a CSRF header, etc.). Called
 * once per adapter operation.
 */
export type RequestInit_ = RequestInit & { headers: Headers };
export type BeforeRequestHook = (
  req: RequestInit_,
  context: { collection: string; operation: string; id?: string }
) => void | Promise<void>;

/**
 * Override the URL path for a given operation. Default resolver is
 * `${baseUrl}/${collection}[/${id}]`. Override when your backend uses a
 * different URL shape (e.g. `/api/v1/memories/owner/{ownerId}`).
 */
export type PathResolver = (
  baseUrl: string,
  collection: string,
  operation: 'get' | 'query' | 'add' | 'set' | 'update' | 'delete',
  id?: string
) => string;

/**
 * Optional transformer for list responses. Some backends wrap lists in
 * `{ items: [...] }` or `{ results: [...] }` instead of the default
 * `{ data: [...] }`. Return a canonicalised `{ data, total?, nextCursor? }`.
 */
export type ListResponseTransform = (raw: unknown) => {
  data: unknown[];
  total?: number;
  nextCursor?: string | null;
};

/**
 * Configuration for `new RestCrudAdapter(config)`.
 */
export interface RestCrudAdapterConfig {
  /**
   * Base URL for the REST API, without trailing slash. Default:
   * `'/api/crud'`. Must be same-origin unless the server serves CORS headers.
   */
  readonly baseUrl?: string;

  /**
   * `credentials` mode for fetch. Default: `'include'` so session cookies
   * are sent on every request. Set to `'omit'` for Bearer-token auth.
   */
  readonly credentials?: RequestCredentials;

  /**
   * Static headers merged into every request (Content-Type is set
   * automatically for requests with a JSON body).
   */
  readonly headers?: Record<string, string>;

  /**
   * Per-request hook — last-chance mutation of the Request before fetch.
   */
  readonly beforeRequest?: BeforeRequestHook;

  /**
   * Override the default URL shape. Default is the classic
   * `${baseUrl}/${collection}[/${id}]` RESTful pattern.
   */
  readonly pathResolver?: PathResolver;

  /**
   * Override the default list response shape (`{ data, total?, nextCursor? }`).
   */
  readonly listResponseTransform?: ListResponseTransform;

  /**
   * Default `fetch` implementation. Defaults to `globalThis.fetch`. Override
   * for custom transports, retries, or testing with a mock.
   */
  readonly fetch?: typeof fetch;
}
