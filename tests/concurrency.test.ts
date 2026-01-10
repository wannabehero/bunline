import { describe, expect, test, afterEach } from "bun:test";
import { Queue } from "../src/queue";
import { unlinkSync } from "fs";

const DB_PATH = "test-concurrency.sqlite";

describe("Concurrency System", () => {
    afterEach(() => {
        try {
            unlinkSync(DB_PATH);
        } catch (e) {}
    });

    test("should handle high concurrency without race conditions", async () => {
        // Setup queue
        const queue = new Queue("concurrency-stress-test", {
            dbPath: DB_PATH,
            pollInterval: 10,
            maxConcurrency: 10 // Not used for this test as we manually poll
        });

        const JOB_COUNT = 100;
        const WORKER_COUNT = 10;

        // Add jobs
        for (let i = 0; i < JOB_COUNT; i++) {
            await queue.add({ id: i });
        }

        const processed = new Set<number>();
        const processedCount = { count: 0 };
        const errors: any[] = [];

        // Simulate concurrent workers
        const workers = Array.from({ length: WORKER_COUNT }, async (_, workerId) => {
            while (true) {
                try {
                    // Manually calling storage.getNextJob to simulate the race condition
                    // that would happen inside queue.loop()
                    const job = queue.storage.getNextJob("concurrency-stress-test", 5000);

                    if (!job) {
                        // Check if we are done
                        const remaining = queue.storage.db.query("SELECT count(*) as c FROM jobs WHERE status = 'pending'").get() as any;
                        if (remaining.c === 0) break;
                        await new Promise(r => setTimeout(r, 10));
                        continue;
                    }

                    // Verify double processing
                    if (processed.has(job.data.id)) {
                        throw new Error(`Double processing detected for job ${job.data.id} by worker ${workerId}`);
                    }
                    processed.add(job.data.id);
                    processedCount.count++;

                    // Complete job
                    queue.storage.completeJob(job.id);
                } catch (e) {
                    errors.push(e);
                    break;
                }
            }
        });

        await Promise.all(workers);

        if (errors.length > 0) {
            console.error("Errors:", errors);
        }

        expect(errors.length).toBe(0);
        expect(processed.size).toBe(JOB_COUNT);
        expect(processedCount.count).toBe(JOB_COUNT);

        // Verify DB state
        const remaining = queue.storage.db.query("SELECT count(*) as c FROM jobs WHERE status != 'completed'").get() as any;
        expect(remaining.c).toBe(0);

        await queue.stop();
    });
});
