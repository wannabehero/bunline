import bunline from "../src";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";

const ASYNC_DB_PATH = "perf-test-async.sqlite";
const WORKER_DB_PATH = "perf-test-worker.sqlite";

interface TestConfig {
  name: string;
  jobCount: number;
  cryptoIterations: number;
  concurrency: number;
}

// Different test scenarios
const SCENARIOS: TestConfig[] = [
  { name: "Light work, low concurrency", jobCount: 500, cryptoIterations: 100, concurrency: 5 },
  { name: "Light work, high concurrency", jobCount: 500, cryptoIterations: 100, concurrency: 20 },
  { name: "Medium work, high concurrency", jobCount: 500, cryptoIterations: 500, concurrency: 20 },
  { name: "Heavy work, high concurrency", jobCount: 300, cryptoIterations: 2000, concurrency: 20 },
  { name: "Very heavy work, high concurrency", jobCount: 100, cryptoIterations: 5000, concurrency: 20 },
];

// Cleanup previous test databases
function cleanupDb(path: string) {
  if (existsSync(path)) {
    unlinkSync(path);
  }
  if (existsSync(path + "-wal")) {
    unlinkSync(path + "-wal");
  }
  if (existsSync(path + "-shm")) {
    unlinkSync(path + "-shm");
  }
}

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
function generateTestData(jobCount: number, cryptoIterations: number): CryptoJobData[] {
  const data: CryptoJobData[] = [];
  for (let i = 0; i < jobCount; i++) {
    data.push({
      input: `test-input-${i}-${Math.random().toString(36)}`,
      iterations: cryptoIterations,
      index: i,
    });
  }
  return data;
}

async function runAsyncTest(
  testData: CryptoJobData[],
  config: TestConfig
): Promise<{ duration: number; completed: number }> {
  cleanupDb(ASYNC_DB_PATH);

  const queueName = "async-crypto-queue";
  const queue = bunline.createQueue<CryptoJobData>(queueName, {
    dbPath: ASYNC_DB_PATH,
    maxConcurrency: config.concurrency,
    pollInterval: 5,
  });

  let processedCount = 0;

  return new Promise((resolve) => {
    const startTime = performance.now();
    let resolved = false;

    queue.process(async (job) => {
      const { input, iterations } = job.data;
      doCryptoWork(input, iterations);
      processedCount++;

      if (processedCount === config.jobCount && !resolved) {
        resolved = true;
        const duration = performance.now() - startTime;
        setImmediate(async () => {
          await queue.stop({ graceful: true, timeout: 5000 });
          resolve({ duration, completed: processedCount });
        });
      }
    });

    for (const data of testData) {
      queue.add(data);
    }
  });
}

async function runWorkerTest(
  testData: CryptoJobData[],
  config: TestConfig
): Promise<{ duration: number; completed: number }> {
  cleanupDb(WORKER_DB_PATH);

  const queueName = "worker-crypto-queue";
  const queue = bunline.createQueue<CryptoJobData>(queueName, {
    dbPath: WORKER_DB_PATH,
    maxConcurrency: config.concurrency,
    pollInterval: 5,
  });

  for (const data of testData) {
    queue.add(data);
  }

  return new Promise((resolve) => {
    const startTime = performance.now();

    queue.process("./examples/perf-crypto-worker.ts");

    const checkInterval = setInterval(() => {
      try {
        const db = new Database(WORKER_DB_PATH, { readonly: true });
        const completed = db.query(
          `SELECT COUNT(*) as count FROM jobs WHERE queue_name = ? AND status = 'completed'`
        ).get(queueName) as { count: number };
        const failed = db.query(
          `SELECT COUNT(*) as count FROM jobs WHERE queue_name = ? AND status = 'failed'`
        ).get(queueName) as { count: number };
        db.close();

        const totalDone = completed.count + failed.count;

        if (totalDone === config.jobCount) {
          clearInterval(checkInterval);
          const duration = performance.now() - startTime;
          queue.stop({ graceful: true, timeout: 5000 }).then(() => {
            resolve({ duration, completed: completed.count });
          });
        }
      } catch {
        // Database might be locked, retry next interval
      }
    }, 50);
  });
}

interface ScenarioResult {
  config: TestConfig;
  asyncDuration: number;
  workerDuration: number;
  asyncThroughput: number;
  workerThroughput: number;
  winner: string;
  speedupPercent: number;
}

async function runScenario(config: TestConfig): Promise<ScenarioResult> {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Scenario: ${config.name}`);
  console.log(`  Jobs: ${config.jobCount} | Crypto iterations: ${config.cryptoIterations} | Concurrency: ${config.concurrency}`);

  const testData = generateTestData(config.jobCount, config.cryptoIterations);

  // Run async test
  process.stdout.write("  Running ASYNC...  ");
  const asyncResult = await runAsyncTest(testData, config);
  console.log(`${asyncResult.duration.toFixed(0)}ms (${asyncResult.completed} jobs)`);

  // Run worker test
  process.stdout.write("  Running WORKER... ");
  const workerResult = await runWorkerTest(testData, config);
  console.log(`${workerResult.duration.toFixed(0)}ms (${workerResult.completed} jobs)`);

  const asyncThroughput = (config.jobCount / asyncResult.duration) * 1000;
  const workerThroughput = (config.jobCount / workerResult.duration) * 1000;

  const winner = asyncResult.duration < workerResult.duration ? "ASYNC" : "WORKER";
  const speedupPercent =
    (Math.abs(asyncResult.duration - workerResult.duration) /
      Math.max(asyncResult.duration, workerResult.duration)) *
    100;

  console.log(`  → Winner: ${winner} (${speedupPercent.toFixed(1)}% faster)`);

  return {
    config,
    asyncDuration: asyncResult.duration,
    workerDuration: workerResult.duration,
    asyncThroughput,
    workerThroughput,
    winner,
    speedupPercent,
  };
}

async function main() {
  console.log("═".repeat(60));
  console.log("BUNLINE PERFORMANCE TEST: Worker Threads vs Async Functions");
  console.log("═".repeat(60));
  console.log("\nRunning multiple scenarios to compare performance...");

  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  // Summary table
  console.log("\n" + "═".repeat(60));
  console.log("RESULTS SUMMARY");
  console.log("═".repeat(60));

  console.log("\n┌─────────────────────────────────────┬──────────┬──────────┬─────────┐");
  console.log("│ Scenario                            │ Async    │ Worker   │ Winner  │");
  console.log("├─────────────────────────────────────┼──────────┼──────────┼─────────┤");

  for (const r of results) {
    const name = r.config.name.padEnd(35);
    const asyncMs = `${r.asyncDuration.toFixed(0)}ms`.padStart(8);
    const workerMs = `${r.workerDuration.toFixed(0)}ms`.padStart(8);
    const winner = r.winner.padStart(7);
    console.log(`│ ${name} │ ${asyncMs} │ ${workerMs} │ ${winner} │`);
  }

  console.log("└─────────────────────────────────────┴──────────┴──────────┴─────────┘");

  // Analysis
  const asyncWins = results.filter((r) => r.winner === "ASYNC").length;
  const workerWins = results.filter((r) => r.winner === "WORKER").length;

  console.log("\nAnalysis:");
  console.log(`  - Async won ${asyncWins}/${results.length} scenarios`);
  console.log(`  - Worker won ${workerWins}/${results.length} scenarios`);

  if (workerWins > 0) {
    const workerWinScenarios = results.filter((r) => r.winner === "WORKER");
    console.log(`  - Workers excel at: ${workerWinScenarios.map((r) => r.config.name).join(", ")}`);
  }

  // Cleanup
  cleanupDb(ASYNC_DB_PATH);
  cleanupDb(WORKER_DB_PATH);

  console.log("\n" + "═".repeat(60));
}

main().catch(console.error);
