import { Queue, type QueueOptions } from "./queue";
import { setupThreadWorker } from "./worker-helper";

export type { Queue, QueueOptions, ProcessorHandler, StopOptions } from "./queue";
export type { Job, JobStatus } from "./storage";

const bunline = {
  createQueue: (name: string, options?: QueueOptions) => new Queue(name, options),
  setupThreadWorker: setupThreadWorker
};

export default bunline;
