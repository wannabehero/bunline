import { parentPort } from "node:worker_threads";
import { type Job, Storage } from "./storage";
import { WorkerPool } from "./worker-pool";

// We use `any` here for incoming messages to avoid strict type definition overhead
// for internal protocol, but we check types at runtime where critical.
declare var self: Worker;

let storage: Storage;
let queueName: string;
let pollInterval: number = 200;
let maxConcurrency: number = 5;
let lockDuration: number = 30000;

let isRunning = false;
let activeJobs = 0;
let timer: Timer | null = null;

// If handler is a path, we use this pool
let workerPool: WorkerPool | null = null;
// If handler is in main thread, we verify this flag
let hasMainThreadHandler = false;

// Map to track async add requests if we wanted to support acknowledging writes,
// though `storage.addJob` is sync in this thread.

if (!parentPort && !self) {
  throw new Error("queue-worker must be run as a worker");
}

const postMessage = (msg: any) => {
  if (self?.postMessage) {
    self.postMessage(msg);
  } else if (parentPort) {
    parentPort.postMessage(msg);
  }
};

const handleMessage = async (event: MessageEvent | any) => {
  const msg = event.data || event;

  switch (msg.type) {
    case "init": {
      queueName = msg.queueName;
      const opts = msg.options || {};
      storage = new Storage(opts.dbPath || "queue.sqlite");
      pollInterval = opts.pollInterval || 200;
      maxConcurrency = opts.maxConcurrency || 5;
      lockDuration = opts.lockDuration || 30000;
      break;
    }

    case "add":
      try {
        const job = storage.addJob(queueName, msg.data, msg.options);
        postMessage({
          type: "add-response",
          requestId: msg.requestId,
          success: true,
          job,
        });
        // Trigger loop if running
        if (isRunning) {
          // If we were sleeping, wake up?
          // The loop uses setTimeout, but we can verify if we need to schedule immediately.
          // For simplicity, just let the next poll cycle pick it up,
          // OR trigger a check if not fully saturated.
        }
      } catch (err: any) {
        postMessage({
          type: "add-response",
          requestId: msg.requestId,
          success: false,
          error: err.message,
        });
      }
      break;

    case "process":
      if (msg.handlerType === "string") {
        workerPool = new WorkerPool(msg.handlerValue, {
          size: maxConcurrency,
        });
      } else {
        hasMainThreadHandler = true;
      }
      start();
      break;

    case "start":
      start();
      break;

    case "stop":
      await stop(msg.options);
      break;

    case "job-result":
      // Main thread finished a job
      handleJobResult(msg.jobId, msg.success, msg.resultOrError);
      break;
  }
};

if (typeof self !== "undefined") {
  self.onmessage = handleMessage;
} else if (parentPort) {
  parentPort.on("message", (msg) => handleMessage({ data: msg }));
}

function start() {
  if (isRunning) return;
  isRunning = true;
  loop();
}

async function stop(options: any = {}) {
  const { graceful = true, timeout = 30000 } = options;

  isRunning = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  if (graceful && activeJobs > 0) {
    const startTime = Date.now();
    while (activeJobs > 0 && Date.now() - startTime < timeout) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (workerPool) {
    await workerPool.terminate();
  }

  if (storage) {
    storage.close();
  }

  postMessage({ type: "stopped" });
  process.exit(0); // Terminate this worker
}

function loop() {
  if (!isRunning) return;

  try {
    const failedJobs = storage.recoverStuckJobs(queueName);
    if (failedJobs && failedJobs.length > 0) {
      for (const job of failedJobs) {
        postMessage({
          type: "job-failed",
          jobId: job.id,
          error: job.last_error,
        });
      }
    }
  } catch (e) {
    console.error("Error recovering stuck jobs:", e);
  }

  if (activeJobs >= maxConcurrency) {
    scheduleNext(pollInterval);
    return;
  }

  try {
    const job = storage.getNextJob(queueName, lockDuration);

    if (job) {
      activeJobs++;
      processJob(job);

      // Try to get another job immediately if we have capacity
      if (activeJobs < maxConcurrency) {
        setImmediate(() => loop());
      }
      return;
    } else {
      scheduleNext(pollInterval);
    }
  } catch (err) {
    console.error("Error in queue loop:", err);
    scheduleNext(pollInterval);
  }
}

function scheduleNext(ms: number) {
  if (!isRunning) return;
  timer = setTimeout(() => loop(), ms);
}

async function processJob(job: Job<any>) {
  if (workerPool) {
    // Process in local worker pool
    try {
      await workerPool.run(job);
      completeJob(job.id);
    } catch (err: any) {
      let errorMessage = String(err);
      if (err instanceof Error) {
        errorMessage = err.message;
        if (err.name && err.name !== "Error") {
          errorMessage = `${err.name}: ${errorMessage}`;
        }
        if (err.stack) {
          errorMessage += `\n${err.stack}`;
        }
      }
      failJob(job.id, errorMessage);
    }
  } else if (hasMainThreadHandler) {
    // Send to main thread
    postMessage({
      type: "exec-job",
      job,
    });
    // activeJobs remains incremented until we get "job-result" back
  } else {
    // No processor?
    failJob(job.id, "No processor registered");
  }
}

function handleJobResult(jobId: number, success: boolean, resultOrError: any) {
  if (success) {
    completeJob(jobId);
  } else {
    failJob(jobId, resultOrError);
  }
}

function completeJob(jobId: number) {
  try {
    storage.completeJob(jobId);
    postMessage({ type: "job-completed", jobId });
  } finally {
    activeJobs--;
    if (isRunning) {
      setImmediate(() => loop());
    }
  }
}

function failJob(jobId: number, error: string) {
  try {
    storage.failJob(jobId, error);
    postMessage({ type: "job-failed", jobId, error });
  } finally {
    activeJobs--;
    if (isRunning) {
      setImmediate(() => loop());
    }
  }
}
