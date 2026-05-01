// packages/providers/restcrud/src/common/queryBuilder.ts

/**
 * @fileoverview Translate `QueryOptions` into a URL query string.
 *
 * Output format (matches the README protocol spec):
 *
 *   ?limit=20
 *   &offset=0
 *   &orderBy=createdAt:desc
 *   &orderBy=topic:asc
 *   &where[category][eq]=preference
 *   &where[id][in]=a,b,c
 *
 * @version 0.1.0
 * @since 0.0.1
 */

import type {
  CrudOperator,
  QueryOptions,
  QueryWhereClause,
} from '@donotdev/core';
import { CRUD_OPERATORS, DoNotDevError, ERROR_CODES } from '@donotdev/core';

/** Map a `CrudOperator` to its URL-friendly short form. */
const OPERATOR_CODE: Readonly<Partial<Record<CrudOperator, string>>> = {
  [CRUD_OPERATORS.EQ]: 'eq',
  [CRUD_OPERATORS.NEQ]: 'neq',
  [CRUD_OPERATORS.LT]: 'lt',
  [CRUD_OPERATORS.LTE]: 'lte',
  [CRUD_OPERATORS.GT]: 'gt',
  [CRUD_OPERATORS.GTE]: 'gte',
  [CRUD_OPERATORS.IN]: 'in',
  [CRUD_OPERATORS.ARRAY_CONTAINS]: 'contains',
};

function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function appendWhere(params: URLSearchParams, clause: QueryWhereClause): void {
  const { field, operator, value } = clause;
  const code = OPERATOR_CODE[operator as CrudOperator];
  if (!code) {
    throw new DoNotDevError(
      `RestCrudAdapter: unsupported operator "${operator as string}"`,
      ERROR_CODES.INVALID_ARGUMENT,
      { context: { operator, field } }
    );
  }
  params.append(`where[${String(field)}][${code}]`, encodeValue(value));
}

/**
 * Build a URL-safe query string from a `QueryOptions` object. Returns
 * an empty string when there are no options. The leading `?` IS included
 * on non-empty output so callers can concat directly.
 */
export function buildQueryString(options: QueryOptions | undefined): string {
  if (!options) return '';
  const params = new URLSearchParams();

  if (typeof options.limit === 'number') {
    params.set('limit', String(options.limit));
  }
  // Map startAfter → cursor (our protocol uses cursor-based pagination on
  // the wire; consumer servers decide whether cursors are offsets, ids, or
  // opaque tokens).
  if (options.startAfter !== undefined && options.startAfter !== null) {
    params.set('cursor', String(options.startAfter));
  }

  if (options.orderBy && options.orderBy.length > 0) {
    for (const clause of options.orderBy) {
      const field = String(clause.field);
      const direction = clause.direction ?? 'asc';
      params.append('orderBy', `${field}:${direction}`);
    }
  }

  if (options.where && options.where.length > 0) {
    for (const clause of options.where) {
      appendWhere(params, clause);
    }
  }

  const str = params.toString();
  return str.length > 0 ? `?${str}` : '';
}
