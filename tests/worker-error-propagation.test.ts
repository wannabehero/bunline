import { describe, it, expect, mock, spyOn } from "bun:test";
import bunline from "../src/index";

const DB_FILE = ":memory:";
const WORKER_FILE = new URL("./worker-error.ts", import.meta.url).pathname;

describe("Worker Error Propagation", () => {
  it("should propagate error stack and name", async () => {
    // Spy on console.error to capture the error object
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    const queue = bunline.createQueue("error-queue", {
      dbPath: DB_FILE,
      pollInterval: 100
    });

    queue.process(WORKER_FILE);

    const job = queue.add({ some: "data" });

    // Wait for the job to fail and be logged
    // We poll until console.error is called
    let retries = 0;
    while (consoleErrorSpy.mock.calls.length === 0 && retries < 20) {
      await new Promise((r) => setTimeout(r, 100));
      retries++;
    }

    await queue.stop();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorArg = consoleErrorSpy.mock.calls.find(call =>
      call[0] && typeof call[0] === 'string' && call[0].includes(`Job ${job.id} failed:`)
    );

    expect(errorArg).toBeDefined();
    const errorObj = errorArg![1]; // The second argument is the error object

    // If verification passes, these should match
    expect(errorObj).toBeInstanceOf(Error);
    // Currently (before fix) these will fail or show generic values
    expect(errorObj.name).toBe("MyCustomTypeError");
    expect(errorObj.stack).toContain("tests/worker-error.ts");

    consoleErrorSpy.mockRestore();
  });
});
