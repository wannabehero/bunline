# Bunline

A lightweight, durable, and fast worker queue for Bun, backed by `bun:sqlite`.

## Features

- **Durable:** Jobs are stored in SQLite. survive restarts.
- **Bun Native:** Built directly on `bun:sqlite` and `Bun.Worker`.
- **Flexible:** Support for both in-process async functions and isolated Worker threads.
- **Reliable:** Atomic locking, retries with backoff, and crash recovery.
- **Concurrency Control:** Limit the number of simultaneous jobs.

## Installation

```bash
bun add bunline
```

## Usage

### 1. Basic In-Process Processing

```typescript
import { Queue } from "bunline";

const queue = new Queue("email-queue", {
  dbPath: "queue.sqlite", // Optional, defaults to queue.sqlite
  maxConcurrency: 5
});

// Process jobs
queue.process(async (job) => {
  console.log("Sending email to:", job.data.email);
  await new Promise(r => setTimeout(r, 1000)); // Simulate work
  // If you throw, the job will be retried
});

// Add jobs
await queue.add({ email: "user@example.com" }, {
    maxRetries: 3,
    backoffType: 'exponential',
    backoffDelay: 1000
});
```

### 2. Using Bun Workers

For CPU-intensive tasks, you can run jobs in a separate thread using `Bun.Worker`.

**worker.ts**
```typescript
import { setupWorker } from "bunline"; // Import helper

setupWorker(async (job) => {
  console.log("Heavy processing:", job.data);
  // Do heavy work...
});
```

**main.ts**
```typescript
import { Queue } from "bunline";

const queue = new Queue("heavy-queue");

// Point to the worker file
queue.process("./worker.ts");

await queue.add({ image: "profile.jpg" });
```

## API

### `new Queue(name, options)`

- `name`: String, name of the queue.
- `options`:
  - `dbPath`: Path to SQLite DB file (default: "queue.sqlite").
  - `maxConcurrency`: Max simultaneous jobs (default: 5).
  - `pollInterval`: Ms to wait when queue is empty (default: 200).
  - `lockDuration`: Ms before a processing job is considered crashed (default: 30000).

### `queue.add(data, options)`

- `data`: Serializable JSON object.
- `options`:
  - `delay`: Ms to delay execution.
  - `maxRetries`: Number of retries on failure.
  - `backoffType`: 'fixed' | 'exponential'.
  - `backoffDelay`: Ms delay between retries.

### `queue.process(handler)`

- `handler`: Either an `async function(job)` OR a `string` (path to worker file).
