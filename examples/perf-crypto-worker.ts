import bunline from "../src/index";

bunline.setupThreadWorker(async (job) => {
  const { input, iterations } = job.data as { input: string; iterations: number };

  // Do crypto work - hash the input multiple times
  let hash = input;

  for (let i = 0; i < iterations; i++) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(hash);
    hash = hasher.digest("hex");
  }

  // Job completes successfully - result is the computed hash
});
