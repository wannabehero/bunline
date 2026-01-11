import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import bunline from "../src/index";

// We use a file-based DB for tests that need to inspect DB or share state
const DB_PATH = "test-queue.sqlite";

describe("Queue System", () => {
  afterEach(() => {
    try {
      unlinkSync(DB_PATH);
    } catch {}
    try {
      unlinkSync(`${DB_PATH}-wal`);
      unlinkSync(`${DB_PATH}-shm`);
    } catch {}
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

    await queue.add({ value: 1 });
    await queue.add({ value: 2 });
    await queue.add({ value: 3 });

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
      await queue.add({ i });
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

    await queue.add(
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

    const job = await queue.add(
      { val: 1 },
      { maxRetries: 1, backoffDelay: 50 },
    );

    let failureEvent: any = null;
    queue.on("failed", (evt) => {
      if (evt.id === job.id) failureEvent = evt;
    });

    queue.process(async (_job) => {
      throw new Error("Always fail");
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await queue.stop();

    expect(failureEvent).not.toBeNull();
    // We can't easily check "attempts" without DB access, but getting "failed" event implies it failed permanently.
  });

  test("should support Bun.Worker processors", async () => {
    const workerCode = `
            import bunline from "${process.cwd()}/src/index.ts";

            bunline.setupThreadWorker(async (job) => {
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

    const completed: number[] = [];
    const failed: number[] = [];

    queue.on("completed", (e) => completed.push(e.id));
    queue.on("failed", (e) => failed.push(e.id));

    const job1 = await queue.add({ fail: false });
    const job2 = await queue.add({ fail: true }, { maxRetries: 0 });

    queue.process("test-worker.ts");

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await queue.stop();
    try {
      unlinkSync("test-worker.ts");
    } catch {}

    expect(completed).toContain(job1.id);
    expect(failed).toContain(job2.id);
  });

  test("should recover from crash (timeout)", async () => {
    // To simulate crash, we manually insert a stuck job into the DB file
    // We need to use a separate connection for this setup
    const { Database } = await import("bun:sqlite");
    const db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode = WAL;");

    // Create table manually since queue might not have created it yet if we haven't started one?
    // Actually, createQueue inits the DB.
    // So we can start a queue, stop it, then manipulate DB.

    let queue = bunline.createQueue("crash-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
      lockDuration: 100,
    });
    // We need to wait for init? createQueue is sync but worker init is async.
    // We can send a dummy add to ensure init.
    await queue.add({ dummy: true });
    await queue.stop();

    // Now manipulate DB
    db.run(
      `
            INSERT INTO jobs (queue_name, data, status, attempts, max_retries, locked_until, created_at, scheduled_for)
            VALUES (?, ?, 'processing', 1, 1, ?, ?, ?)
        `,
      ["crash-test", "{}", Date.now() - 2000, Date.now(), Date.now()],
    );

    // Restart queue
    queue = bunline.createQueue("crash-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
      lockDuration: 100,
    });

    let processed = false;
    queue.process(async (job) => {
      if (!job.data.dummy) processed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await queue.stop();
    db.close();

    expect(processed).toBe(true);
  });

  test("should fail job after max retries on crash", async () => {
    // Setup DB
    const { Database } = await import("bun:sqlite");
    const db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode = WAL;");

    // Init DB by creating/stopping a queue
    let queue = bunline.createQueue("crash-fail-test", { dbPath: DB_PATH });
    await queue.add({ dummy: true });
    await queue.stop();

    // Insert stuck job with attempts > max_retries
    db.run(
      `
            INSERT INTO jobs (queue_name, data, status, attempts, max_retries, locked_until, created_at)
            VALUES (?, ?, 'processing', 2, 1, ?, ?)
        `,
      ["crash-fail-test", "{}", Date.now() - 2000, Date.now()],
    );

    // Restart queue
    queue = bunline.createQueue("crash-fail-test", {
      dbPath: DB_PATH,
      pollInterval: 50,
      lockDuration: 100,
    });

    let failedId: number | null = null;
    let failedError: string | null = null;

    queue.on("failed", (e) => {
      // We don't know the ID of the manually inserted job easily, but we can capture it
      failedId = e.id;
      failedError = e.error;
    });

    queue.process(async () => {});

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await queue.stop();
    db.close();

    expect(failedId).not.toBeNull();
    // The manually inserted job
    expect(failedError).toBe("Job crashed or timed out");
  });
});
