import type { Job } from "./storage";

interface WorkerPoolOptions {
  size: number;
}

interface WorkerWrapper {
  worker: Worker;
  busy: boolean;
  resolve?: (value: void | PromiseLike<void>) => void;
  reject?: (reason?: any) => void;
}

export class WorkerPool {
  private workers: WorkerWrapper[] = [];
  private queue: { job: Job; resolve: any; reject: any }[] = [];
  private workerPath: string;
  private size: number;

  constructor(workerPath: string, options: WorkerPoolOptions) {
    this.workerPath = workerPath;
    this.size = options.size;
    this.init();
  }

  private init() {
    for (let i = 0; i < this.size; i++) {
      this.addWorker();
    }
  }

  private addWorker() {
    // Use global Worker
    const worker = new Worker(this.workerPath);

    const wrapper: WorkerWrapper = {
      worker,
      busy: false,
    };

    worker.onmessage = (event) => {
      const { type, error } = event.data;

      if (wrapper.resolve && wrapper.reject) {
        if (type === "success") {
          wrapper.resolve();
        } else if (type === "error") {
          wrapper.reject(new Error(error));
        }

        // Cleanup
        wrapper.resolve = undefined;
        wrapper.reject = undefined;
        wrapper.busy = false;

        // Try to process next in queue
        this.processQueue();
      }
    };

    worker.onerror = (err) => {
      if (wrapper.reject) {
        wrapper.reject(err);
      }
      // Replace the dead worker
      this.workers = this.workers.filter((w) => w !== wrapper);
      wrapper.worker.terminate();
      this.addWorker();
    };

    this.workers.push(wrapper);
  }

  async run(job: Job): Promise<void> {
    return new Promise((resolve, reject) => {
      const availableWorker = this.workers.find((w) => !w.busy);

      if (availableWorker) {
        this.execute(availableWorker, job, resolve, reject);
      } else {
        this.queue.push({ job, resolve, reject });
      }
    });
  }

  private execute(wrapper: WorkerWrapper, job: Job, resolve: any, reject: any) {
    wrapper.busy = true;
    wrapper.resolve = resolve;
    wrapper.reject = reject;
    wrapper.worker.postMessage(job);
  }

  private processQueue() {
    if (this.queue.length === 0) return;

    const availableWorker = this.workers.find((w) => !w.busy);
    if (availableWorker) {
      const next = this.queue.shift();
      if (next) {
        this.execute(availableWorker, next.job, next.resolve, next.reject);
      }
    }
  }

  async terminate() {
    for (const w of this.workers) {
      w.worker.terminate();
    }
    this.workers = [];
    this.queue = [];
  }
}
