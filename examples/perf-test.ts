import bunline from "../src";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";

const ASYNC_DB_PATH = "perf-test-async.sqlite";
const WORKER_DB_PATH = "perf-test-worker.sqlite";
const JOB_COUNT = 1000;
const CRYPTO_ITERATIONS = 100; // Number of hash iterations per job
const MAX_CONCURRENCY = 10;

// Cleanup previous test databases
function cleanupDb(path: string) {
  if (existsSync(path)) {
    unlinkSync(path);
  }
  // Also cleanup WAL files
  if (existsSync(path + "-wal")) {
    unlinkSync(path + "-wal");
  }
  if (existsSync(path + "-shm")) {
    unlinkSync(path + "-shm");
  }
}

cleanupDb(ASYNC_DB_PATH);
cleanupDb(WORKER_DB_PATH);

interface CryptoJobData {
  input: string;
  iterations: number;
  index: number;
}

// Crypto work function - same logic used in both modes
function doCryptoWork(input: string, iterations: number): string {
  let hash = input;

  for (let i = 0; i < iterations; i++) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hash);
    hash = hasher.digest("hex");
  }

  return hash;
}

// Generate test data
function generateTestData(): CryptoJobData[] {
  const data: CryptoJobData[] = [];
  for (let i = 0; i < JOB_COUNT; i++) {
    data.push({
      input: `test-input-${i}-${Math.random().toString(36)}`,
      iterations: CRYPTO_ITERATIONS,
      index: i,
    });
  }
  return data;
}

// Pre-compute expected results for verification
function computeExpectedResults(testData: CryptoJobData[]): Map<number, string> {
  const results = new Map<number, string>();
  for (const item of testData) {
    results.set(item.index, doCryptoWork(item.input, item.iterations));
  }
  return results;
}

async function runAsyncTest(testData: CryptoJobData[]): Promise<{
  duration: number;
  results: Map<number, string>;
}> {
  console.log("\n--- Running ASYNC Function Test ---");

  const queueName = "async-crypto-queue";
  const queue = bunline.createQueue<CryptoJobData>(queueName, {
    dbPath: ASYNC_DB_PATH,
    maxConcurrency: MAX_CONCURRENCY,
    pollInterval: 10, // Fast polling for performance test
  });

  const results = new Map<number, string>();
  let processedCount = 0;

  return new Promise((resolve) => {
    const startTime = performance.now();
    let resolved = false;

    queue.process(async (job) => {
      const { input, iterations, index } = job.data;
      const hash = doCryptoWork(input, iterations);
      results.set(index, hash);
      processedCount++;

      if (processedCount === JOB_COUNT && !resolved) {
        resolved = true;
        const duration = performance.now() - startTime;
        // Use setImmediate to let the current job handler complete before stopping
        setImmediate(async () => {
          await queue.stop({ graceful: true, timeout: 5000 });
          resolve({ duration, results });
        });
      }
    });

    // Add all jobs
    for (const data of testData) {
      queue.add(data);
    }

    console.log(`Added ${JOB_COUNT} jobs to async queue`);
  });
}

async function runWorkerTest(testData: CryptoJobData[]): Promise<{
  duration: number;
  completedCount: number;
}> {
  console.log("\n--- Running WORKER Thread Test ---");

  const queueName = "worker-crypto-queue";
  const queue = bunline.createQueue<CryptoJobData>(queueName, {
    dbPath: WORKER_DB_PATH,
    maxConcurrency: MAX_CONCURRENCY,
    pollInterval: 10,
  });

  // Add all jobs first
  for (const data of testData) {
    queue.add(data);
  }
  console.log(`Added ${JOB_COUNT} jobs to worker queue`);

  return new Promise((resolve) => {
    const startTime = performance.now();

    // Use the worker file
    queue.process("./examples/perf-crypto-worker.ts");

    // Track completion by polling database
    const checkInterval = setInterval(() => {
      try {
        const db = new Database(WORKER_DB_PATH, { readonly: true });
        const completed = db.query(
          `SELECT COUNT(*) as count FROM jobs WHERE queue_name = ? AND status = 'completed'`
        ).get(queueName) as { count: number };
        const failed = db.query(
          `SELECT COUNT(*) as count FROM jobs WHERE queue_name = ? AND status = 'failed'`
        ).get(queueName) as { count: number };
        const processing = db.query(
          `SELECT COUNT(*) as count FROM jobs WHERE queue_name = ? AND status = 'processing'`
        ).get(queueName) as { count: number };
        db.close();

        const totalDone = completed.count + failed.count;

        // Log progress every 100 jobs
        if (totalDone % 100 === 0 && totalDone > 0) {
          console.log(`  Progress: ${completed.count} completed, ${failed.count} failed, ${processing.count} processing`);
        }

        if (totalDone === JOB_COUNT) {
          clearInterval(checkInterval);
          const duration = performance.now() - startTime;
          queue.stop({ graceful: true, timeout: 5000 }).then(() => {
            resolve({ duration, completedCount: completed.count });
          });
        }
      } catch (e) {
        // Database might be locked, retry next interval
      }
    }, 100);
  });
}

async function main() {
  console.log("=".repeat(60));
  console.log("BUNLINE PERFORMANCE TEST: Worker Threads vs Async Functions");
  console.log("=".repeat(60));
  console.log(`\nConfiguration:`);
  console.log(`  - Jobs: ${JOB_COUNT}`);
  console.log(`  - Crypto iterations per job: ${CRYPTO_ITERATIONS}`);
  console.log(`  - Max concurrency: ${MAX_CONCURRENCY}`);
  console.log(`  - Work: SHA-256 hashing (${CRYPTO_ITERATIONS}x per job)`);

  // Generate test data
  console.log("\nGenerating test data...");
  const testData = generateTestData();

  // Pre-compute expected results for async verification
  console.log("Pre-computing expected results for verification...");
  const expectedResults = computeExpectedResults(testData);

  // Run async test first (clean database)
  const asyncResult = await runAsyncTest(testData);

  // Verify async results
  let asyncCorrect = 0;
  for (const [index, hash] of asyncResult.results) {
    if (expectedResults.get(index) === hash) {
      asyncCorrect++;
    }
  }

  console.log(`\nAsync Results:`);
  console.log(`  - Duration: ${asyncResult.duration.toFixed(2)}ms`);
  console.log(`  - Processed: ${asyncResult.results.size} jobs`);
  console.log(`  - Correct: ${asyncCorrect}/${JOB_COUNT}`);
  console.log(`  - Throughput: ${((JOB_COUNT / asyncResult.duration) * 1000).toFixed(2)} jobs/sec`);

  // Run worker test (uses separate database)
  const workerResult = await runWorkerTest(testData);

  console.log(`\nWorker Results:`);
  console.log(`  - Duration: ${workerResult.duration.toFixed(2)}ms`);
  console.log(`  - Completed: ${workerResult.completedCount} jobs`);
  console.log(`  - Throughput: ${((JOB_COUNT / workerResult.duration) * 1000).toFixed(2)} jobs/sec`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const faster = asyncResult.duration < workerResult.duration ? "ASYNC" : "WORKER";
  const speedup = Math.abs(asyncResult.duration - workerResult.duration) /
    Math.max(asyncResult.duration, workerResult.duration) * 100;

  console.log(`\n  Async:  ${asyncResult.duration.toFixed(2)}ms`);
  console.log(`  Worker: ${workerResult.duration.toFixed(2)}ms`);
  console.log(`\n  Winner: ${faster} (${speedup.toFixed(1)}% faster)`);
  console.log(`\n  Correctness:`);
  console.log(`    - Async: ${asyncCorrect === JOB_COUNT ? "PASS" : "FAIL"} (${asyncCorrect}/${JOB_COUNT})`);
  console.log(`    - Worker: ${workerResult.completedCount === JOB_COUNT ? "PASS" : "FAIL"} (${workerResult.completedCount}/${JOB_COUNT} completed)`);

  // Cleanup
  cleanupDb(ASYNC_DB_PATH);
  cleanupDb(WORKER_DB_PATH);

  console.log("\n" + "=".repeat(60));
}

main().catch(console.error);
