import { Database, type Statement } from "bun:sqlite";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface RawJobRow {
  id: number;
  queue_name: string;
  data: string;
  status: JobStatus;
  attempts: number;
  max_retries: number;
  backoff_type: "fixed" | "exponential";
  backoff_delay: number; // in ms
  created_at: number;
  updated_at: number;
  scheduled_for: number;
  locked_until: number | null;
  last_error: string | null;
}

export interface Job<T = unknown> {
  id: number;
  queue_name: string;
  data: T;
  status: JobStatus;
  attempts: number;
  max_retries: number;
  backoff_type: "fixed" | "exponential";
  backoff_delay: number; // in ms
  created_at: number;
  updated_at: number;
  scheduled_for: number;
  locked_until: number | null;
  last_error: string | null;
}

interface PreparedStatements {
  addJob: Statement;
  getNextJob: Statement;
  completeJob: Statement;
  getJobById: Statement;
  retryJob: Statement;
  failJobPermanently: Statement;
  recoverRetryableJobs: Statement;
  recoverFailedJobs: Statement;
}

export class Storage {
  public db: Database; // Made public for testing access if needed
  private statements!: PreparedStatements;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.init();
    this.prepareStatements();
  }

  private init() {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = FULL;");
    this.db.run("PRAGMA busy_timeout = 5000;");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_name TEXT NOT NULL,
        data TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 0,
        backoff_type TEXT DEFAULT 'fixed',
        backoff_delay INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        scheduled_for INTEGER,
        locked_until INTEGER,
        last_error TEXT
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled ON jobs(status, scheduled_for);
    `);

    this.db.run(`
       CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON jobs(queue_name, status);
    `);
  }

  private prepareStatements() {
    this.statements = {
      addJob: this.db.prepare(`
        INSERT INTO jobs (
          queue_name, data, status, max_retries, backoff_type, backoff_delay,
          created_at, updated_at, scheduled_for
        ) VALUES ($queueName, $data, 'pending', $maxRetries, $backoffType, $backoffDelay, $now, $now, $scheduledFor)
        RETURNING *
      `),
      getNextJob: this.db.prepare(`
        UPDATE jobs
        SET status = 'processing', locked_until = $lockedUntil, attempts = attempts + 1, updated_at = $now
        WHERE id = (
          SELECT id FROM jobs
          WHERE queue_name = $queueName
            AND status = 'pending'
            AND scheduled_for <= $now
          ORDER BY scheduled_for ASC
          LIMIT 1
        )
        AND status = 'pending'
        RETURNING *
      `),
      completeJob: this.db.prepare(`
        UPDATE jobs SET status = 'completed', locked_until = NULL, updated_at = $now WHERE id = $id
      `),
      getJobById: this.db.prepare(`
        SELECT * FROM jobs WHERE id = $id
      `),
      retryJob: this.db.prepare(`
        UPDATE jobs
        SET status = 'pending', locked_until = NULL, updated_at = $now, scheduled_for = $scheduledFor, last_error = $error
        WHERE id = $id
      `),
      failJobPermanently: this.db.prepare(`
        UPDATE jobs
        SET status = 'failed', locked_until = NULL, updated_at = $now, last_error = $error
        WHERE id = $id
      `),
      recoverRetryableJobs: this.db.prepare(`
        UPDATE jobs
        SET status = 'pending', locked_until = NULL, updated_at = $now
        WHERE queue_name = $queueName
          AND status = 'processing'
          AND locked_until < $now
          AND attempts <= max_retries
      `),
      recoverFailedJobs: this.db.prepare(`
        UPDATE jobs
        SET status = 'failed', locked_until = NULL, updated_at = $now, last_error = 'Job crashed or timed out'
        WHERE queue_name = $queueName
          AND status = 'processing'
          AND locked_until < $now
          AND attempts > max_retries
      `),
    };
  }

  addJob<T>(
    queueName: string,
    data: T,
    options: {
      maxRetries?: number;
      backoffType?: "fixed" | "exponential";
      backoffDelay?: number;
      delay?: number;
    } = {},
  ): Job<T> {
    const now = Date.now();
    const scheduledFor = now + (options.delay || 0);

    const result = this.statements.addJob.get({
      $queueName: queueName,
      $data: JSON.stringify(data),
      $maxRetries: options.maxRetries ?? 0,
      $backoffType: options.backoffType ?? "fixed",
      $backoffDelay: options.backoffDelay ?? 1000,
      $now: now,
      $scheduledFor: scheduledFor,
    }) as RawJobRow;

    return this.parseJob<T>(result);
  }

  /**
   * Atomically claims the next available job for a specific queue.
   */
  getNextJob<T = unknown>(
    queueName: string,
    lockDurationMs: number = 30000,
  ): Job<T> | null {
    const now = Date.now();
    const lockedUntil = now + lockDurationMs;

    const job = this.statements.getNextJob.get({
      $queueName: queueName,
      $now: now,
      $lockedUntil: lockedUntil,
    }) as RawJobRow | undefined;

    if (job) {
      return this.parseJob<T>(job);
    }

    return null;
  }

  completeJob(id: number) {
    this.statements.completeJob.run({ $now: Date.now(), $id: id });
  }

  failJob(id: number, error: string) {
    const now = Date.now();

    // We need to check if we should retry
    const job = this.statements.getJobById.get({ $id: id }) as
      | RawJobRow
      | undefined;
    if (!job) return; // Should not happen

    const currentJob = this.parseJob(job);

    if (currentJob.attempts <= currentJob.max_retries) {
      // Retry
      let delay = currentJob.backoff_delay;
      if (currentJob.backoff_type === "exponential") {
        delay = delay * 2 ** (currentJob.attempts - 1);
      }
      const nextSchedule = now + delay;

      this.statements.retryJob.run({
        $now: now,
        $scheduledFor: nextSchedule,
        $error: error,
        $id: id,
      });
    } else {
      // Fail permanently
      this.statements.failJobPermanently.run({
        $now: now,
        $error: error,
        $id: id,
      });
    }
  }

  recoverStuckJobs(queueName: string) {
    const now = Date.now();

    // 1. Recover jobs that can still be retried
    this.statements.recoverRetryableJobs.run({
      $now: now,
      $queueName: queueName,
    });

    // 2. Fail jobs that have exceeded max retries
    this.statements.recoverFailedJobs.run({ $now: now, $queueName: queueName });
  }

  close() {
    this.db.close();
  }

  private parseJob<T = unknown>(row: RawJobRow): Job<T> {
    let data: T;
    try {
      data = JSON.parse(row.data) as T;
    } catch (e) {
      console.error(`Failed to parse job ${row.id} data as JSON:`, e);
      // Return raw string cast as T if parsing fails, or we could set it to null/undefined if T allows
      // For now, we'll cast the string to T to avoid runtime crashes, though it might break consumers expecting an object.
      // But this is an exceptional case.
      data = row.data as unknown as T;
    }
    const { data: _rawData, ...rest } = row;
    return {
      ...rest,
      data,
    };
  }
}
