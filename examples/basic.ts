import bunline from "bunline";

const queue = bunline.createQueue("email-queue", {
  dbPath: "examples.sqlite",
});

console.log("Starting email queue...");

queue.process(async (job) => {
  console.log(`[${job.id}] Sending email to ${job.data.email}...`);
  await new Promise((r) => setTimeout(r, 1000));

  if (Math.random() > 0.8) {
    throw new Error("Random SMTP failure!");
  }

  console.log(`[${job.id}] Sent!`);
});

// Add some jobs
for (let i = 1; i <= 5; i++) {
  queue.add({ email: `user${i}@example.com` }, { maxRetries: 2 });
}
