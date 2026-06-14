/**
 * Simple Telemetry Service for Week 7 Services
 * Provides basic metrics recording capability
 */

import { logger } from '../../../utils/Logger';

export class TelemetryService {
    private metrics = new Map<string, unknown[]>();

    recordMetric(name: string, value: number | string, metadata?: unknown): void {
        if (!this.metrics.has(name)) {
            this.metrics.set(name, []);
        }

        this.metrics.get(name)!.push({
            value,
            metadata,
            timestamp: new Date()
        });

        // In a real implementation, this would send to a metrics service
        logger.debug(`[TELEMETRY] ${name}: ${value}`, metadata as any);
    }

    getMetrics(name: string): unknown[] {
        return this.metrics.get(name) || [];
    }

    getAllMetrics(): { [key: string]: unknown[] } {
        const result: { [key: string]: unknown[] } = {};
        this.metrics.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    clearMetrics(): void {
        this.metrics.clear();
    }
}