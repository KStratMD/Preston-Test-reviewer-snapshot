import { injectable, inject } from "inversify";
import type { Kysely } from "kysely";
import type { DatabaseService } from "../DatabaseService";
import { TYPES } from "../../inversify/types";
import type {
  Database,
  IntegrationJob,
  NewIntegrationJob,
  IntegrationJobUpdate,
} from "../types";

/**
 * Repository for integration job data access
 */
@injectable()
export class IntegrationJobRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) databaseService: DatabaseService) {
    this.db = databaseService.getDatabase();
  }

  /**
   * Create a new integration job
   */
  async create(job: NewIntegrationJob): Promise<IntegrationJob> {
    const result = await this.db
      .insertInto("integration_jobs")
      .values({
        ...job,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  /**
   * Find job by ID
   */
  async findById(id: string): Promise<IntegrationJob | null> {
    const result = await this.db
      .selectFrom("integration_jobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return result || null;
  }

  /**
   * Find job by queue job ID
   */
  async findByQueueJobId(queueJobId: string): Promise<IntegrationJob | null> {
    const result = await this.db
      .selectFrom("integration_jobs")
      .selectAll()
      .where("queue_job_id", "=", queueJobId)
      .executeTakeFirst();

    return result || null;
  }

  /**
   * Find jobs by integration ID
   */
  async findByIntegrationId(
    integrationId: string,
    options?: {
      limit?: number;
      offset?: number;
      status?: string;
      orderBy?: "created_at" | "updated_at";
      orderDirection?: "asc" | "desc";
    },
  ): Promise<IntegrationJob[]> {
    let query = this.db
      .selectFrom("integration_jobs")
      .selectAll()
      .where("integration_id", "=", integrationId);

    if (options?.status) {
      query = query.where("status", "=", options.status as IntegrationJob["status"]);
    }

    if (options?.orderBy) {
      query = query.orderBy(options.orderBy, options.orderDirection || "desc");
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.offset(options.offset);
    }

    return query.execute();
  }

  /**
   * Update job
   */
  async update(id: string, updates: IntegrationJobUpdate): Promise<IntegrationJob> {
    const result = await this.db
      .updateTable("integration_jobs")
      .set({
        ...updates,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return result;
  }

  /**
   * Update job status
   */
  async updateStatus(
    id: string,
    status: "pending" | "processing" | "completed" | "failed" | "cancelled",
    errorMessage?: string,
  ): Promise<IntegrationJob> {
    const updates: IntegrationJobUpdate = {
      status,
      updated_at: new Date(),
    };

    if (status === "processing" && !await this.hasStartedAt(id)) {
      updates.started_at = new Date();
    }

    if (status === "completed" || status === "failed" || status === "cancelled") {
      updates.completed_at = new Date();
    }

    if (errorMessage) {
      updates.error_message = errorMessage;
    }

    return this.update(id, updates);
  }

  /**
   * Update job progress
   */
  async updateProgress(
    id: string,
    processedRecords: number,
    failedRecords: number,
  ): Promise<IntegrationJob> {
    return this.update(id, {
      processed_records: processedRecords,
      failed_records: failedRecords,
    });
  }

  /**
   * Get job statistics for integration
   */
  async getJobStatistics(integrationId: string, days = 30): Promise<{
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    averageProcessingTime: number;
    totalRecordsProcessed: number;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const stats = await this.db
      .selectFrom("integration_jobs")
      .select([
        (eb) => eb.fn.count("id").as("total_jobs"),
        (eb) => eb.fn.countAll().filterWhere("status", "=", "completed").as("completed_jobs"),
        (eb) => eb.fn.countAll().filterWhere("status", "=", "failed").as("failed_jobs"),
        (eb) => eb.fn.sum("processed_records").as("total_records_processed"),
        (eb) => eb.fn.avg(
          eb.fn("EXTRACT", [eb.val("EPOCH FROM (completed_at - started_at)")]),
        ).as("avg_processing_time"),
      ])
      .where("integration_id", "=", integrationId)
      .where("created_at", ">=", since)
      .executeTakeFirst();

    return {
      totalJobs: Number(stats?.total_jobs || 0),
      completedJobs: Number(stats?.completed_jobs || 0),
      failedJobs: Number(stats?.failed_jobs || 0),
      averageProcessingTime: Number(stats?.avg_processing_time || 0),
      totalRecordsProcessed: Number(stats?.total_records_processed || 0),
    };
  }

  /**
   * Get active jobs count
   */
  async getActiveJobsCount(): Promise<number> {
    const result = await this.db
      .selectFrom("integration_jobs")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("status", "in", ["pending", "processing"])
      .executeTakeFirst();

    return Number(result?.count || 0);
  }

  /**
   * Delete old completed jobs
   */
  async deleteOldJobs(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.db
      .deleteFrom("integration_jobs")
      .where("status", "in", ["completed", "failed", "cancelled"])
      .where("completed_at", "<", cutoffDate)
      .executeTakeFirst();

    return Number(result.numDeletedRows || 0);
  }

  /**
   * Check if job has started_at timestamp
   */
  private async hasStartedAt(id: string): Promise<boolean> {
    const result = await this.db
      .selectFrom("integration_jobs")
      .select("started_at")
      .where("id", "=", id)
      .executeTakeFirst();

    return result?.started_at !== null;
  }
}
