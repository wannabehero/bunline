import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import bunline from "../src/index";

const DB_PATH = "concurrency.sqlite";

describe("Concurrency System", () => {
  try {
    unlinkSync(DB_PATH);
  } catch {}

  test("should handle high concurrency without race conditions", async () => {
    // Setup queue
    // We use a file based DB to share between multiple queue instances if we wanted,
    // but here we just want to test if the queue worker handles concurrent add/process correctly.

    // Actually, `queue-worker` is single threaded (one worker loop).
    // Concurrency inside `queue-worker` is achieved via `maxConcurrency` (async tasks).

    const queue = bunline.createQueue("concurrency-stress-test", {
      dbPath: DB_PATH,
      pollInterval: 10,
      maxConcurrency: 10,
    });

    const JOB_COUNT = 50;

    // Add jobs concurrently
    const addPromises = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      addPromises.push(queue.add({ id: i }));
    }
    await Promise.all(addPromises);

    const processed = new Set<number>();
    const processedCount = { count: 0 };

    queue.on("completed", (_evt) => {
      // We can't know the job ID -> data mapping easily without keeping track
      // But we can trust the queue to process them.
      processedCount.count++;
    });

    // Processor
    queue.process(async (job) => {
      if (processed.has(job.data.id)) {
        throw new Error("Double process");
      }
      processed.add(job.data.id);
      await new Promise((r) => setTimeout(r, 10));
    });

    // Wait for completion
    let retries = 0;
    while (processedCount.count < JOB_COUNT && retries < 100) {
      await new Promise((r) => setTimeout(r, 100));
      retries++;
    }

    await queue.stop();
    try {
      unlinkSync(DB_PATH);
    } catch {}
    try {
      unlinkSync(`${DB_PATH}-wal`);
      unlinkSync(`${DB_PATH}-shm`);
    } catch {}

    expect(processedCount.count).toBe(JOB_COUNT);
    expect(processed.size).toBe(JOB_COUNT);
  });
});
