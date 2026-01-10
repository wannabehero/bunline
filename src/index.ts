import { Queue, type QueueOptions } from "./queue";
import { setupThreadWorker } from "./worker-helper";

export type {
  ProcessorHandler,
  Queue,
  QueueOptions,
  StopOptions,
} from "./queue";
export type { Job, JobStatus } from "./storage";

const bunline = {
  createQueue: <T = unknown>(name: string, options?: QueueOptions) =>
    new Queue<T>(name, options),
  setupThreadWorker: setupThreadWorker,
};

export default bunline;
