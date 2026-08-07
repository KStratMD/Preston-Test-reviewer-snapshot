/**
 * Shared pagination helpers for connector route files.
 *
 * DemoConnectorDecorator exposes a count() method for accurate demo totals.
 * These helpers provide a uniform "unknown total" contract when count is
 * unavailable (non-demo / real API connectors).
 */

import type { IConnector } from '../interfaces/IConnector';

/**
 * Parse and clamp page/pageSize from query string values.
 * Returns safe integers (page >= 1, pageSize >= 1) and the computed offset.
 */
export function parsePagination(
  rawPage: string | undefined,
  rawPageSize: string | undefined,
  defaultPageSize = 50,
): { page: number; pageSize: number; offset: number } {
  const safeDefault = defaultPageSize >= 1 ? defaultPageSize : 50;
  let page = parseInt(rawPage || '1', 10);
  let pageSize = parseInt(rawPageSize || String(safeDefault), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = safeDefault;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * Get the total record count from the connector if it supports count().
 * Returns -1 when count is unavailable (non-demo / real API).
 */
export function getCount(
  connector: IConnector,
  entityType: string,
  filters?: Record<string, unknown>,
  operator?: 'AND' | 'OR',
): number {
  if ('count' in connector && typeof (connector as Record<string, unknown>).count === 'function') {
    return (connector as Record<string, unknown> & { count: (e: string, f?: Record<string, unknown>, o?: 'AND' | 'OR') => number }).count(entityType, filters, operator);
  }
  return -1;
}

/**
 * Build pagination metadata with "unknown total" contract.
 * When count is -1: total=null, totalKnown=false, hasMore based on heuristic.
 * Guards against NaN / non-positive inputs from user query params.
 */
export function buildPagination(page: number, pageSize: number, itemCount: number, count: number) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 1;
  return {
    page: safePage,
    pageSize: safePageSize,
    total: count !== -1 ? count : null,
    totalKnown: count !== -1,
    hasMore: count !== -1
      ? (safePage - 1) * safePageSize + itemCount < count
      : itemCount === safePageSize,
  };
}
