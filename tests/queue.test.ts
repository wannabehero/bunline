import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import bunline from "../src/index";
import { Storage } from "../src/storage";

const DB_PATH = "test-queue.sqlite";

describe("Queue System", () => {
  afterEach(() => {
    try {
      unlinkSync(DB_PATH);
    } catch (_e) {}
  });

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

    queue.process(async (_job) => {
      throw new Error("Always fail");
    });

    const job = queue.add({ val: 1 }, { maxRetries: 1, backoffDelay: 50 });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await queue.stop();

    const storage = bunline.createQueue("fail-test-check", {
      dbPath: DB_PATH,
    }).storage;
    // @ts-expect-error
    const savedJob = storage.db
      .query("SELECT * FROM jobs WHERE id = ?")
      .get(job.id) as any;
    expect(savedJob.status).toBe("failed");
    expect(savedJob.attempts).toBe(2); // 1 initial + 1 retry
    storage.close();
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
    writeFileSync("test-worker.ts", workerCode);

    const queue = bunline.createQueue("worker-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
    });

    queue.process("test-worker.ts");

    queue.add({ fail: false });
    queue.add({ fail: true }, { maxRetries: 0 });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await queue.stop();
    unlinkSync("test-worker.ts");

    const storage = bunline.createQueue("worker-test-check", {
      dbPath: DB_PATH,
    }).storage;
    // @ts-expect-error
    const jobs = storage.db
      .query("SELECT * FROM jobs ORDER BY id")
      .all() as any[];
    expect(jobs[0].status).toBe("completed");
    expect(jobs[1].status).toBe("failed");
    storage.close();
  });

  test("should recover from crash (timeout)", async () => {
    const storage = new Storage(DB_PATH);
    // Stuck 2 seconds ago. Max retries 1 so it can be retried once more.
    storage.db.run(
      `
            INSERT INTO jobs (queue_name, data, status, attempts, max_retries, locked_until, created_at, scheduled_for)
            VALUES (?, ?, 'processing', 1, 1, ?, ?, ?)
        `,
      ["crash-test", "{}", Date.now() - 2000, Date.now(), Date.now()],
    );
    storage.close();

    const queue = bunline.createQueue("crash-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
      lockDuration: 100,
    });

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
    const storage = new Storage(DB_PATH);
    // Stuck job that has already exceeded retries
    // attempts: 2, max_retries: 1
    storage.db.run(
      `
            INSERT INTO jobs (queue_name, data, status, attempts, max_retries, locked_until, created_at)
            VALUES (?, ?, 'processing', 2, 1, ?, ?)
        `,
      ["crash-fail-test", "{}", Date.now() - 2000, Date.now()],
    );
    storage.close();

    const queue = bunline.createQueue("crash-fail-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
      lockDuration: 100,
    });

    // Start the queue loop
    queue.process(async () => {});

    // The queue loop should mark it as failed immediately
    await new Promise((resolve) => setTimeout(resolve, 500));
    await queue.stop();

    const checkStorage = new Storage(DB_PATH);
    // @ts-expect-error
    const job = checkStorage.db
      .query("SELECT * FROM jobs WHERE queue_name = ?")
      .get("crash-fail-test") as any;
    expect(job.status).toBe("failed");
    expect(job.last_error).toBe("Job crashed or timed out");
    checkStorage.close();
  });
});
