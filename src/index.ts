import { Queue, type QueueOptions } from "./queue";
import { setupWorker } from "./worker-helper";

export type { Queue, QueueOptions, ProcessorHandler, StopOptions } from "./queue";
export type { Job, JobStatus } from "./storage";

const bunline = {
  createQueue: (name: string, options?: QueueOptions) => new Queue(name, options),
  createWorker: setupWorker
};

export default bunline;
