import type { Job } from "./storage";

declare var self: Worker;

export function setupThreadWorker<T = unknown>(
  handler: (job: Job<T>) => Promise<void> | void,
) {
  // Bun Workers use self.onmessage
  self.onmessage = async (event: MessageEvent) => {
    const job = event.data as Job<T>;
    try {
      await handler(job);
      self.postMessage({ type: "success", id: job.id });
    } catch (error: unknown) {
      if (error instanceof Error) {
        self.postMessage({
          type: "error",
          id: job.id,
          error: error.message,
          stack: error.stack,
          name: error.name,
        });
      } else {
        self.postMessage({
          type: "error",
          id: job.id,
          error: String(error),
        });
      }
    }
  };
}
