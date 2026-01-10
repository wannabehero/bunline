import { afterEach, describe, expect, test } from "bun:test";
import bunline from "../src/index";
import type { Database } from "bun:sqlite";

const DB_PATH = ":memory:";

describe("Queue System", () => {
  // No file cleanup needed for in-memory DB

  test("should process jobs in FIFO order", async () => {
    const queue = bunline.createQueue("fifo-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
    });
    const processed: number[] = [];

    queue.process(async (job) => {
      processed.push(job.data.value);
    });

    queue.add({ value: 1 });
    queue.add({ value: 2 });
    queue.add({ value: 3 });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await queue.stop();

    expect(processed).toEqual([1, 2, 3]);
  });

  test("should handle concurrency limits", async () => {
    const queue = bunline.createQueue("concurrency-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
      maxConcurrency: 2,
    });

    let active = 0;
    let maxActive = 0;

    queue.process(async (_job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 100)); // simulate work
      active--;
    });

    for (let i = 0; i < 5; i++) {
      queue.add({ i });
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await queue.stop();

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("should retry failed jobs with backoff", async () => {
    const queue = bunline.createQueue("retry-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
    });
    const attempts: number[] = [];

    queue.process(async (job) => {
      attempts.push(Date.now());
      if (job.attempts < 3) {
        throw new Error("Fail!");
      }
    });

    queue.add(
      { val: 1 },
      {
        maxRetries: 2,
        backoffDelay: 200,
        backoffType: "fixed",
      },
    );

    // Initial attempt (0ms) -> Fail
    // Retry 1 (scheduled +200ms) -> Fail
    // Retry 2 (scheduled +200ms) -> Success
    // Total wait needs to cover at least 400ms + processing time
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await queue.stop();

    expect(attempts.length).toBe(3);

    const diff1 = attempts[1] - attempts[0];
    const diff2 = attempts[2] - attempts[1];
    expect(diff1).toBeGreaterThanOrEqual(150);
    expect(diff2).toBeGreaterThanOrEqual(150);
  });

  test("should move to failed status after max retries", async () => {
    const queue = bunline.createQueue("fail-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
    });

    const job = queue.add({ val: 1 }, { maxRetries: 1, backoffDelay: 50 });

    queue.process(async (_job) => {
      throw new Error("Always fail");
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check DB BEFORE stopping the queue (which closes the in-memory DB)
    const db = ((queue as any).storage as any).db as Database;
    // @ts-expect-error
    const savedJob = db.query("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
    expect(savedJob.status).toBe("failed");
    expect(savedJob.attempts).toBe(2); // 1 initial + 1 retry

    await queue.stop();
  });

  test("should support Bun.Worker processors", async () => {
    // Updated worker code to simulate package usage as much as possible,
    // but since we are inside the repo, we point to src/index.ts.
    // The user wants 'bunline.setupThreadWorker'
    const workerCode = `
            import bunline from "${process.cwd()}/src/index.ts";

            bunline.setupThreadWorker(async (job) => {
                // console.log("Worker processing:", job.data);
                if (job.data.fail) throw new Error("Worker failed");
                await new Promise(r => setTimeout(r, 50));
            });
        `;
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync("test-worker.ts", workerCode);

    const queue = bunline.createQueue("worker-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
    });

    queue.add({ fail: false });
    queue.add({ fail: true }, { maxRetries: 0 });

    queue.process("test-worker.ts");

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check DB BEFORE stopping
    const db = ((queue as any).storage as any).db as Database;
    // @ts-expect-error
    const jobs = db.query("SELECT * FROM jobs ORDER BY id").all() as any[];
    expect(jobs[0].status).toBe("completed");
    expect(jobs[1].status).toBe("failed");

    await queue.stop();
    unlinkSync("test-worker.ts");
  });

  test("should recover from crash (timeout)", async () => {
    const queue = bunline.createQueue("crash-test", {
        dbPath: DB_PATH,
        pollInterval: 50,
        lockDuration: 100,
      });

    const db = ((queue as any).storage as any).db as Database;
    // Stuck 2 seconds ago. Max retries 1 so it can be retried once more.
    db.run(
      `
            INSERT INTO jobs (queue_name, data, status, attempts, max_retries, locked_until, created_at, scheduled_for)
            VALUES (?, ?, 'processing', 1, 1, ?, ?, ?)
        `,
      ["crash-test", "{}", Date.now() - 2000, Date.now(), Date.now()],
    );

    let processed = false;
    queue.process(async (_job) => {
      processed = true;
    });

    // Loop runs -> recoverStuckJobs (resets to pending) -> getNextJob -> process
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await queue.stop();

    expect(processed).toBe(true);
  });

  test("should fail job after max retries on crash", async () => {
    const queue = bunline.createQueue("crash-fail-test", {
        dbPath: DB_PATH,
        pollInterval: 50,
        lockDuration: 100,
      });

    const db = ((queue as any).storage as any).db as Database;

    // Stuck job that has already exceeded retries
    // attempts: 2, max_retries: 1
    db.run(
      `
            INSERT INTO jobs (queue_name, data, status, attempts, max_retries, locked_until, created_at)
            VALUES (?, ?, 'processing', 2, 1, ?, ?)
        `,
      ["crash-fail-test", "{}", Date.now() - 2000, Date.now()],
    );

    // Start the queue loop
    queue.process(async () => {});

    // The queue loop should mark it as failed immediately
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check DB BEFORE stopping
    // @ts-expect-error
    const job = db.query("SELECT * FROM jobs WHERE queue_name = ?").get("crash-fail-test") as any;
    expect(job.status).toBe("failed");
    expect(job.last_error).toBe("Job crashed or timed out");

    await queue.stop();
  });
});
