/**
 * Tier 6 — concurrency check.
 *
 * Fires a slow run and a fast run at the same time. If sandboxes are truly
 * independent (each its own container), the fast one should finish quickly
 * regardless of the slow one — not wait for it. If they interfere, the fast
 * run's time will balloon toward the slow run's time.
 *
 * Run from the project root:  node tests/concurrency-test.js
 */

const BASE_URL = process.env.SANDBOX_URL || "http://localhost:4000";

async function run(label, code) {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "python", code }),
  });
  const data = await res.json();
  const elapsed = Date.now() - start;
  return { label, elapsed, data };
}

async function main() {
  console.log(`Firing a slow run and a fast run at the same time against ${BASE_URL} ...\n`);

  const slowCode = `import time\ntime.sleep(4)\nprint("slow done")`;
  const fastCode = `print("fast done")`;

  const [slow, fast] = await Promise.all([
    run("slow (sleeps 4s)", slowCode),
    run("fast (instant)", fastCode),
  ]);

  console.log(`${slow.label}: ${slow.elapsed}ms`);
  console.log(`${fast.label}: ${fast.elapsed}ms`);

  if (fast.elapsed < slow.elapsed / 2) {
    console.log("\n✅ Fast run wasn't blocked by the slow one — sandboxes are running independently.");
  } else {
    console.log(
      "\n❌ Fast run took nearly as long as the slow one — something is serializing runs instead of isolating them."
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Concurrency test failed to run:", err.message);
  process.exit(1);
});
