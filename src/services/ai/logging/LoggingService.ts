/**
 * Simple Logging Service for Week 7 Services
 * Wraps the existing Logger utility
 */

import { Logger } from '../../../utils/Logger';

export class LoggingService {
    private logger: Logger;

    constructor() {
        this.logger = new Logger('Week7Services');
    }

    info(message: string, metadata?: unknown): void {
        this.logger.info(message, metadata as any);
    }

    error(message: string, error: unknown, metadata?: unknown): void {
        this.logger.error(message, error, metadata as any);
    }

    debug(message: string, metadata?: unknown): void {
        this.logger.debug(message, metadata as any);
    }

    warn(message: string, metadata?: unknown): void {
        this.logger.warn(message, metadata as any);
    }
}