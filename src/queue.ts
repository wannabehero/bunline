import { Storage, Job } from "./storage";
import { WorkerPool } from "./worker-pool";

export type ProcessorHandler<T = unknown> = ((job: Job<T>) => Promise<void>) | string;

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
    backoffType?: 'fixed' | 'exponential';
    backoffDelay?: number;
    delay?: number;
}

export class Queue<T = unknown> {
  public storage: Storage; // Made public for testing
  private queueName: string;
  private pollInterval: number;
  private maxConcurrency: number;
  private lockDuration: number;
  private isRunning: boolean = false;
  private activeJobs: number = 0;
  private processor: ProcessorHandler<T> | null = null;
  private timer: Timer | null = null;
  private workerPool: WorkerPool | null = null;

  constructor(queueName: string, options: QueueOptions = {}) {
    this.queueName = queueName;
    this.storage = new Storage(options.dbPath || "queue.sqlite");
    this.pollInterval = options.pollInterval || 200;
    this.maxConcurrency = options.maxConcurrency || 5;
    this.lockDuration = options.lockDuration || 30000;
  }

  /**
   * Add a job to the queue
   */
  async add(data: T, options: AddOptions = {}): Promise<Job<T>> {
    return this.storage.addJob<T>(this.queueName, data, options);
  }

  /**
   * Register a processor and start processing
   */
  process(handler: ProcessorHandler<T>) {
    if (this.processor) {
      throw new Error("Processor already registered for this queue");
    }
    this.processor = handler;

    if (typeof handler === 'string') {
        // Initialize worker pool
        this.workerPool = new WorkerPool(handler, {
            size: this.maxConcurrency
        });
    }

    this.start();
  }

  /**
   * Start the polling loop
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loop();
  }

  /**
   * Stop the queue
   * @param options.graceful - If true, wait for active jobs to complete (default: true)
   * @param options.timeout - Max ms to wait for active jobs (default: 30000)
   */
  async stop(options: StopOptions = {}) {
    const { graceful = true, timeout = 30000 } = options;

    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (graceful && this.activeJobs > 0) {
      const startTime = Date.now();
      while (this.activeJobs > 0 && Date.now() - startTime < timeout) {
        await new Promise(r => setTimeout(r, 50));
      }

      if (this.activeJobs > 0) {
        console.warn(`Force stopping with ${this.activeJobs} jobs still active after ${timeout}ms timeout`);
      }
    }

    if (this.workerPool) {
      await this.workerPool.terminate();
    }
    this.storage.close();
  }

  private async loop() {
    if (!this.isRunning) return;

    try {
        this.storage.recoverStuckJobs(this.queueName);
    } catch (e) {
        console.error("Error recovering stuck jobs:", e);
    }

    if (this.activeJobs >= this.maxConcurrency) {
      this.scheduleNext(this.pollInterval);
      return;
    }

    try {
      const job = this.storage.getNextJob<T>(this.queueName, this.lockDuration);

      if (job) {
        this.activeJobs++;
        this.handleJob(job).finally(() => {
            this.activeJobs--;
            if (this.isRunning) {
                // Trigger immediate loop to process next job faster
                setImmediate(() => this.loop());
            }
        });

        if (this.activeJobs < this.maxConcurrency) {
            setImmediate(() => this.loop());
        }
        return;
      } else {
        this.scheduleNext(this.pollInterval);
      }
    } catch (err) {
      console.error("Error in queue loop:", err);
      this.scheduleNext(this.pollInterval);
    }
  }

  private scheduleNext(ms: number) {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => this.loop(), ms);
  }

  private async handleJob(job: Job<T>) {
    try {
      if (!this.processor) {
        throw new Error("No processor registered");
      }

      if (typeof this.processor === 'function') {
        await this.processor(job);
      } else if (this.workerPool) {
        await this.workerPool.run(job as Job<unknown>); // Worker pool deals with unknown/any, serialization handles types
      }

      this.storage.completeJob(job.id);
    } catch (err: unknown) {
      console.error(`Job ${job.id} failed:`, err);
      let errorMessage = "Unknown error";
      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (typeof err === 'string') {
        errorMessage = err;
      }
      this.storage.failJob(job.id, errorMessage);
    }
  }
}
