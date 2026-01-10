import bunline from "bunline";

bunline.setupThreadWorker(async (job) => {
  console.log(`[Worker ${process.pid}] Resizing image: ${job.data.file}`);

  // Simulate CPU work
  const start = Date.now();
  while (Date.now() - start < 1000) {}

  console.log(`[Worker ${process.pid}] Done: ${job.data.file}`);
});
