import { EventEmitter } from "node:events";
import type { Job } from "./storage";

export type ProcessorHandler<T = unknown> =
  | ((job: Job<T>) => Promise<void>)
  | string;

export interface QueueOptions {
  dbPath?: string;
  maxConcurrency?: number;
  pollInterval?: number;
  lockDuration?: number; // ms
}

export interface StopOptions {
  graceful?: boolean;
  timeout?: number; // ms to wait for active jobs
}

export interface AddOptions {
  maxRetries?: number;
  backoffType?: "fixed" | "exponential";
  backoffDelay?: number;
  delay?: number;
}

export class Queue<T = unknown> extends EventEmitter {
  private worker: Worker;
  private processor: ProcessorHandler<T> | null = null;
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (err: any) => void }
  > = new Map();
  private isStopped = false;

  constructor(queueName: string, options: QueueOptions = {}) {
    super();
    // Use a relative URL to load the worker file.
    // In a published package, this relies on the file being present alongside this one.
    this.worker = new Worker(new URL("./queue-worker.ts", import.meta.url));

    this.worker.onmessage = (event) => this.handleMessage(event);
    this.worker.onerror = (err) => {
      console.error("Queue worker error:", err);
    };

    this.worker.postMessage({
      type: "init",
      queueName,
      options,
    });
  }

  private handleMessage(event: MessageEvent) {
    const msg = event.data;

    switch (msg.type) {
      case "add-response": {
        const req = this.pendingRequests.get(msg.requestId);
        if (req) {
          if (msg.success) {
            req.resolve(msg.job);
          } else {
            req.reject(new Error(msg.error));
          }
          this.pendingRequests.delete(msg.requestId);
        }
        break;
      }
      case "exec-job":
        this.handleExecJob(msg.job);
        break;
      case "job-completed":
        this.emit("completed", { id: msg.jobId });
        break;
      case "job-failed":
        this.emit("failed", { id: msg.jobId, error: msg.error });
        break;
      case "stopped":
        this.isStopped = true;
        this.worker.terminate();
        break;
    }
  }

  private async handleExecJob(job: Job<T>) {
    if (typeof this.processor !== "function") {
      // Should not happen if logic is correct
      this.worker.postMessage({
        type: "job-result",
        jobId: job.id,
        success: false,
        resultOrError: "Processor is not a function",
      });
      return;
    }

    try {
      await this.processor(job);
      this.worker.postMessage({
        type: "job-result",
        jobId: job.id,
        success: true,
      });
    } catch (err: unknown) {
      let errorMessage = "Unknown error";
      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (typeof err === "string") {
        errorMessage = err;
      }
      this.worker.postMessage({
        type: "job-result",
        jobId: job.id,
        success: false,
        resultOrError: errorMessage,
      });
    }
  }

  /**
   * Add a job to the queue
   */
  add(data: T, options: AddOptions = {}): Promise<Job<T>> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.worker.postMessage({
        type: "add",
        data,
        options,
        requestId,
      });
    });
  }

  /**
   * Register a processor and start processing
   */
  process(handler: ProcessorHandler<T>) {
    if (this.processor) {
      throw new Error("Processor already registered for this queue");
    }
    this.processor = handler;

    const handlerType = typeof handler === "string" ? "string" : "function";
    const handlerValue = typeof handler === "string" ? handler : undefined;

    this.worker.postMessage({
      type: "process",
      handlerType,
      handlerValue,
    });
  }

  /**
   * Start the polling loop
   */
  start() {
    this.worker.postMessage({ type: "start" });
  }

  /**
   * Stop the queue
   * @param options.graceful - If true, wait for active jobs to complete (default: true)
   * @param options.timeout - Max ms to wait for active jobs (default: 30000)
   */
  async stop(options: StopOptions = {}) {
    if (this.isStopped) return;

    return new Promise<void>((resolve) => {
      // We listen for the "stopped" message or termination
      // But actually, the worker sends "stopped" and then we terminate.
      // So we can just resolve when we get the stopped message?
      // The current handleMessage terminates the worker on 'stopped'.
      // We need to hook into that.

      const checkStopped = () => {
        if (this.isStopped) {
          resolve();
        } else {
          setTimeout(checkStopped, 50);
        }
      };

      this.worker.postMessage({ type: "stop", options });
      checkStopped();
    });
  }
}
