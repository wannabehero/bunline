import { describe, expect, test } from "bun:test";
import { Queue } from "../src/queue";

describe("Queue Events", () => {
  test("should emit job:added event", () => {
    const queue = new Queue("test-events-added");
    let eventEmitted = false;

    queue.on("job:added", (job) => {
      eventEmitted = true;
      expect(job.data).toEqual({ foo: "bar" });
    });

    queue.add({ foo: "bar" });
    expect(eventEmitted).toBe(true);
    queue.stop();
  });

  test("should emit job:started and job:completed events", async () => {
    const queue = new Queue("test-events-lifecycle");
    const events: string[] = [];

    queue.on("job:started", (job) => {
      events.push("started");
      expect(job.data).toEqual({ task: 1 });
    });

    queue.on("job:completed", (job) => {
      events.push("completed");
      expect(job.data).toEqual({ task: 1 });
    });

    queue.process(async (job) => {
      // Simulate work
    });

    queue.add({ task: 1 });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events).toEqual(["started", "completed"]);
    queue.stop();
  });

  test("should emit job:failed when job fails and retries", async () => {
    const queue = new Queue("test-events-failed", { pollInterval: 10 });
    let failedEventCount = 0;
    let exhaustedEventCount = 0;

    queue.on("job:failed", (job, error, willRetry) => {
      failedEventCount++;
      if (failedEventCount === 1) {
        expect(willRetry).toBe(true);
      }
    });

    queue.on("job:exhausted", () => {
      exhaustedEventCount++;
    });

    let attempts = 0;
    queue.process(async (job) => {
      attempts++;
      throw new Error("Fail attempt " + attempts);
    });

    queue.add({ id: 1 }, { maxRetries: 1, backoffDelay: 10 });

    // Wait for first failure and retry
    // The pollInterval is 10ms, backoff is 10ms.
    // It should happen very quickly.

    // Check initial state
    await new Promise((resolve) => setTimeout(resolve, 100));
    // It might have failed twice already if the backoff is short and poll interval is short

    // Let's just wait enough time for both attempts
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(failedEventCount).toBe(2);
    expect(exhaustedEventCount).toBe(1);

    queue.stop();
  });

  test("should emit job:exhausted when retries are used up", async () => {
    const queue = new Queue("test-events-exhausted", { pollInterval: 10 });
    let exhaustedCalled = false;

    queue.on("job:exhausted", (job, error) => {
      exhaustedCalled = true;
      expect(error.message).toBe("Fail permanently");
    });

    queue.process(async (job) => {
      throw new Error("Fail permanently");
    });

    queue.add({ id: 2 }, { maxRetries: 0 });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exhaustedCalled).toBe(true);
    queue.stop();
  });
});
