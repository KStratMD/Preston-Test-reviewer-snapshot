// Type definitions for BullMQ when package is not available
declare module 'bullmq' {
  export interface JobOptions {
    removeOnComplete?: number;
    removeOnFail?: number;
    delay?: number;
    attempts?: number;
    backoff?: { type: string; delay: number } | string | number;
    priority?: number;
  }

  export interface QueueOptions {
    connection: unknown;
    defaultJobOptions?: JobOptions;
  }

  export interface Job<T = any> {
    id: string;
    name: string;
    data: T;
    processedOn?: number;
    attemptsMade?: number;
    progress?: unknown;
    retry(): Promise<void>;
    updateProgress(progress: number | object): Promise<void>;
  }

  export interface WorkerOptions {
    connection: unknown;
    removeOnComplete?: number;
    removeOnFail?: number;
    concurrency?: number;
    processor?: (job: Job) => Promise<void>;
  }

  export class Queue {
    constructor(name: string, options?: QueueOptions);
    add(name: string, data: unknown, options?: JobOptions): Promise<Job>;
    getJob(id: string): Promise<Job | null>;
    getJobs(types: string[], start?: number, end?: number): Promise<Job[]>;
    getWaiting(): Promise<Job[]>;
    getActive(): Promise<Job[]>;
    getCompleted(): Promise<Job[]>;
    getFailed(): Promise<Job[]>;
    getDelayed(): Promise<Job[]>;
    getCounts(): Promise<{ waiting: number; active: number; completed: number; failed: number; delayed: number; paused: number }>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    isPaused(): Promise<boolean>;
    close(): Promise<void>;
    removeJobs(pattern: string): Promise<number>;
    clean(grace: number, status: string, limit?: number): Promise<Job[]>;
  }

  export class Worker {
    constructor(queueName: string, processor: (job: Job) => Promise<void>, options?: WorkerOptions);
    on(event: string, callback: (...args: unknown[]) => void): void;
    close(): Promise<void>;
  }

  export class QueueEvents {
    constructor(queueName: string, options?: { connection: unknown });
    on(event: string, callback: (...args: unknown[]) => void): void;
    close(): Promise<void>;
  }
}

declare module 'ioredis' {
  export default class Redis {
    constructor();
    constructor(options: unknown);
    on(event: string, callback: (...args: unknown[]) => void): void;
    disconnect(): void;
  }
}