import { describe, expect, test, afterAll } from "bun:test";
import { Queue } from "../src/queue";
import { Job } from "../src/storage";

describe("Generics and Type Safety", () => {
  const dbPath = ":memory:";

  test("should handle generic job data types", async () => {
    interface EmailJob {
      email: string;
      subject: string;
    }

    const queue = new Queue<EmailJob>("email-queue", { dbPath });

    // Type checking would happen here in TypeScript
    const job = await queue.add({ email: "test@example.com", subject: "Hello" });

    expect(job.data.email).toBe("test@example.com");
    expect(job.data.subject).toBe("Hello");

    await queue.stop();
  });

  test("should handle basic types as job data", async () => {
    const queue = new Queue<string>("string-queue", { dbPath });
    const job = await queue.add("some string data");

    expect(job.data).toBe("some string data");

    await queue.stop();
  });

  test("should handle complex nested objects", async () => {
    interface ComplexJob {
        user: {
            id: number;
            profile: {
                name: string;
            }
        },
        tags: string[]
    }

    const queue = new Queue<ComplexJob>("complex-queue", { dbPath });
    const data: ComplexJob = {
        user: {
            id: 123,
            profile: {
                name: "John Doe"
            }
        },
        tags: ["a", "b"]
    };

    const job = await queue.add(data);
    expect(job.data.user.id).toBe(123);
    expect(job.data.user.profile.name).toBe("John Doe");
    expect(job.data.tags).toHaveLength(2);

    await queue.stop();
  });
});
