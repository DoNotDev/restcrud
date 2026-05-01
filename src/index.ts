// packages/providers/restcrud/src/index.ts

/**
 * @donotdev/restcrud — REST CRUD provider for DoNotDev.
 *
 * Drop-in replacement for the Firebase / Supabase adapters when your app
 * talks to its own self-hosted JSON API. See README.md for the protocol
 * spec and quickstart.
 *
 * @packageDocumentation
 */

export { RestCrudAdapter } from './client/crudAdapter';
export { buildQueryString } from './common/queryBuilder';
export type {
  BeforeRequestHook,
  ListResponseTransform,
  PathResolver,
  RestCrudAdapterConfig,
} from './common/types';
