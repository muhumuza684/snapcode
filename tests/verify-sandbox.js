/**
 * Tier 6 — automated isolation checks.
 *
 * Replaces the manual "paste this into the browser and eyeball it" testing
 * from earlier with something you can just re-run. Requires the server to
 * already be running (npm start in server/) — this hits it over HTTP like a
 * real client would, it doesn't touch Docker directly.
 *
 * Run from the project root:  node tests/verify-sandbox.js
 */

const BASE_URL = process.env.SANDBOX_URL || "http://localhost:4000";

async function run(language, code, stdin = "") {
  const res = await fetch(`${BASE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language, code, stdin }),
  });
  return res.json();
}

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log(`Verifying sandbox at ${BASE_URL} ...\n`);

  // 1. Network really is blocked
  const netResult = await run(
    "python",
    `import urllib.request\ntry:\n    urllib.request.urlopen("https://example.com", timeout=3)\n    print("NETWORK WORKED")\nexcept Exception as e:\n    print("BLOCKED")`
  );
  check(
    "Network is blocked",
    (netResult.output || "").includes("BLOCKED") && !(netResult.output || "").includes("NETWORK WORKED"),
    netResult.output
  );

  // 2. Memory limit is enforced
  const memResult = await run(
    "python",
    `data = bytearray(300 * 1024 * 1024)\nprint("ALLOCATED")`
  );
  check(
    "Memory limit is enforced (OOM-killed)",
    memResult.oomKilled === true,
    `oomKilled=${memResult.oomKilled}`
  );

  // 3. Timeout kills runaway code
  const timeoutResult = await run("python", `while True:\n    pass`);
  check("Timeout kills runaway code", timeoutResult.timedOut === true);

  // 4. State doesn't persist between runs
  await run("python", `with open("leftover.txt", "w") as f:\n    f.write("x")\nprint("wrote")`);
  const persistResult = await run(
    "python",
    `import os\nprint(os.path.exists("leftover.txt"))`
  );
  check(
    "Each run starts fresh (no leftover state)",
    (persistResult.output || "").trim() === "False",
    persistResult.output
  );

  // 5. Pre-installed package works
  const pkgResult = await run("python", `import requests\nprint("PACKAGE_OK")`);
  check(
    "Pre-installed package (requests) is importable",
    (pkgResult.output || "").includes("PACKAGE_OK"),
    pkgResult.errorOutput
  );

  // 6. Stdin is actually delivered
  const stdinResult = await run("python", `name = input()\nprint(f"got: {name}")`, "TestUser");
  check(
    "Stdin is delivered to the program",
    (stdinResult.output || "").includes("got: TestUser"),
    stdinResult.output || `(no stdout) stderr: ${stdinResult.errorOutput || "(empty)"}`
  );

  // 7. Go actually compiles and runs (new language — different mechanism
  // than the interpreted languages, worth its own explicit check).
  const goResult = await run(
    "go",
    `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("go works")\n}`
  );
  check(
    "Go compiles and runs",
    (goResult.output || "").includes("go works"),
    goResult.output || `(no stdout) stderr: ${goResult.errorOutput || "(empty)"}`
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log("Failed:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verification script itself failed to run:", err.message);
  console.error("Is the server actually running at", BASE_URL, "?");
  process.exit(1);
});
