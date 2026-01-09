import { Queue } from "../src";

const queue = new Queue("image-queue", {
    dbPath: "examples.sqlite",
    maxConcurrency: 2 // Run 2 workers in parallel
});

console.log("Starting image processing queue with Workers...");

// Use the worker file
queue.process("./examples/image-worker.ts");

// Add jobs
for (let i = 1; i <= 5; i++) {
    queue.add({ file: `photo_${i}.jpg` });
}
