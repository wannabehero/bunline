import { Database } from "bun:sqlite";

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: number;
  queue_name: string;
  data: any;
  status: JobStatus;
  attempts: number;
  max_retries: number;
  backoff_type: 'fixed' | 'exponential';
  backoff_delay: number; // in ms
  created_at: number;
  updated_at: number;
  scheduled_for: number;
  locked_until: number | null;
  last_error: string | null;
}

export class Storage {
  public db: Database; // Made public for testing access if needed

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.run('PRAGMA journal_mode = WAL;');
    this.db.run('PRAGMA synchronous = FULL;');
    this.db.run('PRAGMA busy_timeout = 5000;');

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

  addJob(
    queueName: string,
    data: any,
    options: {
      maxRetries?: number;
      backoffType?: 'fixed' | 'exponential';
      backoffDelay?: number;
      delay?: number;
    } = {}
  ): Job {
    const now = Date.now();
    const scheduledFor = now + (options.delay || 0);

    const result = this.db.query(`
      INSERT INTO jobs (
        queue_name, data, status, max_retries, backoff_type, backoff_delay,
        created_at, updated_at, scheduled_for
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      RETURNING *;
    `).get(
      queueName,
      JSON.stringify(data),
      options.maxRetries ?? 0,
      options.backoffType ?? 'fixed',
      options.backoffDelay ?? 1000,
      now,
      now,
      scheduledFor
    ) as any;

    return this.parseJob(result);
  }

  /**
   * Atomically claims the next available job for a specific queue.
   */
  getNextJob(queueName: string, lockDurationMs: number = 30000): Job | null {
    const now = Date.now();
    const lockedUntil = now + lockDurationMs;

    const job = this.db.query(`
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
      RETURNING *;
    `).get({
      $queueName: queueName,
      $now: now,
      $lockedUntil: lockedUntil
    }) as any;

    if (job) {
      return this.parseJob(job);
    }

    return null;
  }

  completeJob(id: number) {
    this.db.run(`
      UPDATE jobs SET status = 'completed', locked_until = NULL, updated_at = ? WHERE id = ?
    `, [Date.now(), id]);
  }

  failJob(id: number, error: string) {
    const now = Date.now();

    // We need to check if we should retry
    const job = this.db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
    if (!job) return; // Should not happen

    const currentJob = this.parseJob(job);

    if (currentJob.attempts <= currentJob.max_retries) {
        // Retry
        let delay = currentJob.backoff_delay;
        if (currentJob.backoff_type === 'exponential') {
            delay = delay * Math.pow(2, currentJob.attempts - 1);
        }
        const nextSchedule = now + delay;

        this.db.run(`
            UPDATE jobs
            SET status = 'pending', locked_until = NULL, updated_at = ?, scheduled_for = ?, last_error = ?
            WHERE id = ?
        `, [now, nextSchedule, error, id]);
    } else {
        // Fail permanently
        this.db.run(`
            UPDATE jobs
            SET status = 'failed', locked_until = NULL, updated_at = ?, last_error = ?
            WHERE id = ?
        `, [now, error, id]);
    }
  }

  recoverStuckJobs(queueName: string) {
      const now = Date.now();

      // 1. Recover jobs that can still be retried
      this.db.run(`
        UPDATE jobs
        SET status = 'pending', locked_until = NULL, updated_at = ?
        WHERE queue_name = ?
          AND status = 'processing'
          AND locked_until < ?
          AND attempts <= max_retries
      `, [now, queueName, now]);

      // 2. Fail jobs that have exceeded max retries
      this.db.run(`
        UPDATE jobs
        SET status = 'failed', locked_until = NULL, updated_at = ?, last_error = 'Job crashed or timed out'
        WHERE queue_name = ?
          AND status = 'processing'
          AND locked_until < ?
          AND attempts > max_retries
      `, [now, queueName, now]);
  }

  close() {
      this.db.close();
  }

  private parseJob(row: any): Job {
    return {
      ...row,
      data: JSON.parse(row.data)
    };
  }
}
