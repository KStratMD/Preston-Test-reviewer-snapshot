/**
 * Module HTTP Client Utility
 *
 * Shared HTTP client for fetching data from SuiteCentral module APIs.
 * Supports feature flag (USE_REAL_MODULE_APIS) for gradual rollout with
 * graceful fallback to mock data when APIs are unavailable.
 *
 * Phase 2 Implementation - AI-Enhanced SuiteCentral 2.0
 */

import type { Logger } from './Logger';

/**
 * Configuration options for module HTTP requests
 */
export interface ModuleHttpOptions {
    /** Request timeout in milliseconds (default: 5000) */
    timeoutMs?: number;
    /** Custom headers to include in the request */
    headers?: Record<string, string>;
    /** Whether to log successful fetches (default: false) */
    logSuccess?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Check if real module APIs should be used based on feature flag
 */
export function useRealModuleApis(): boolean {
    return process.env.USE_REAL_MODULE_APIS === 'true';
}

/**
 * Fetch data from a module API endpoint with automatic fallback to mock data.
 *
 * Behavior based on USE_REAL_MODULE_APIS environment variable:
 * - 'true': Attempts real HTTP request, falls back to mock on failure
 * - anything else (default): Returns mock data immediately without HTTP request
 *
 * @param endpoint - The API endpoint to fetch from (relative or absolute URL)
 * @param fallbackData - Mock data to return if API is disabled or unavailable
 * @param logger - Logger instance for error/warning messages
 * @param options - Additional request options
 * @returns The fetched data or fallback data
 *
 * @example
 * ```typescript
 * const kpis = await fetchModuleData(
 *   'http://localhost:3000/api/supplier-central/dashboard',
 *   { activeVendors: 100, pendingPOs: 50 },
 *   logger
 * );
 * ```
 */
export async function fetchModuleData<T>(
    endpoint: string,
    fallbackData: T,
    logger: Logger,
    options: ModuleHttpOptions = {}
): Promise<T> {
    // If feature flag is not enabled, return mock data immediately
    if (!useRealModuleApis()) {
        return fallbackData;
    }

    const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, logSuccess = false } = options;

    try {
        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...headers,
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as T;

        if (logSuccess) {
            logger.info('Module API data fetched successfully', { endpoint });
        }

        return data;
    } catch (error) {
        // Log warning but don't fail - gracefully fallback to mock data
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Module API unavailable, using fallback data', {
            endpoint,
            error: errorMessage,
        });

        return fallbackData;
    }
}

/**
 * Fetch data from multiple module endpoints in parallel with fallbacks.
 *
 * @param requests - Array of endpoint/fallback pairs
 * @param logger - Logger instance
 * @param options - Shared request options
 * @returns Array of fetched/fallback data in same order as requests
 */
export async function fetchModuleDataBatch<T>(
    requests: { endpoint: string; fallbackData: T }[],
    logger: Logger,
    options: ModuleHttpOptions = {}
): Promise<T[]> {
    const results = await Promise.all(
        requests.map(({ endpoint, fallbackData }) =>
            fetchModuleData(endpoint, fallbackData, logger, options)
        )
    );

    return results;
}

/**
 * Check if a module API endpoint is reachable (health check).
 *
 * @param endpoint - The API endpoint to check
 * @param logger - Logger instance
 * @param timeoutMs - Request timeout (default: 2000ms for health checks)
 * @returns true if endpoint is reachable, false otherwise
 */
export async function isModuleApiAvailable(
    endpoint: string,
    logger: Logger,
    timeoutMs = 2000
): Promise<boolean> {
    if (!useRealModuleApis()) {
        return false;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(endpoint, {
            method: 'HEAD',
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        return response.ok;
    } catch {
        return false;
    }
}
