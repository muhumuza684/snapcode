/**
 * Tier 7 — basic security self-check.
 *
 * This is NOT a professional penetration test — it's a small set of
 * automated checks for the specific hardening flags this project sets
 * (dropped capabilities, no-new-privileges, PID limits, read-only rootfs).
 * A real audit by someone whose job is breaking sandboxes is still worth
 * doing before this is ever exposed beyond your own machine — this just
 * catches the obvious regressions if a future change accidentally weakens
 * the hardening.
 *
 * Run from the project root (server must be running): node tests/security-check.js
 */

const BASE_URL = process.env.SANDBOX_URL || "http://localhost:4000";

async function run(code) {
  const res = await fetch(`${BASE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "python", code }),
  });
  return res.json();
}

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log(`Running security self-check against ${BASE_URL} ...\n`);

  // 1. Read-only root filesystem — writing outside /tmp should fail.
  const writeResult = await run(
    `try:\n    with open("/usr/should_not_write.txt", "w") as f:\n        f.write("x")\n    print("WROTE")\nexcept Exception as e:\n    print("BLOCKED")`
  );
  check(
    "Root filesystem is read-only",
    (writeResult.output || "").includes("BLOCKED"),
    writeResult.output
  );

  // 2. Capabilities dropped — binding a privileged port (<1024) should fail.
  const portResult = await run(
    `import socket\ntry:\n    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n    s.bind(("0.0.0.0", 80))\n    print("BOUND")\nexcept Exception as e:\n    print("BLOCKED")`
  );
  check(
    "Cannot bind privileged ports (capabilities dropped)",
    (portResult.output || "").includes("BLOCKED"),
    portResult.output
  );

  // 3. PID limit — a fork bomb should hit the limit quickly, not hang.
  const forkResult = await run(
    `import os\ncount = 0\ntry:\n    for _ in range(200):\n        os.fork()\n        count += 1\nexcept Exception:\n    pass\nprint(f"forked {count} before failing")`
  );
  check(
    "Fork bomb is capped by PID limit",
    !forkResult.timedOut && (forkResult.output || "").includes("forked"),
    forkResult.output || (forkResult.timedOut ? "run timed out instead of being capped" : "")
  );

  // 4. Docker socket should never be reachable from inside the sandbox.
  const socketResult = await run(
    `import os\nprint("EXPOSED" if os.path.exists("/var/run/docker.sock") else "SAFE")`
  );
  check(
    "Docker socket is not exposed inside the sandbox",
    (socketResult.output || "").includes("SAFE"),
    socketResult.output
  );

  // 5. Code must not run as root inside the container.
  const userResult = await run(
    `import os\nprint("ROOT" if os.geteuid() == 0 else "NON_ROOT")`
  );
  check(
    "Code runs as a non-root user",
    (userResult.output || "").includes("NON_ROOT"),
    userResult.output
  );

  // 6. /tmp is writable but must not be executable — a script dropped there
  // should fail to run, even though writing to it succeeds.
  const tmpExecResult = await run(
    `import os, stat, subprocess\npath = "/tmp/should_not_exec.sh"\nwith open(path, "w") as f:\n    f.write("#!/bin/sh\\necho SHOULD_NOT_RUN\\n")\nos.chmod(path, 0o755)\ntry:\n    out = subprocess.run([path], capture_output=True, timeout=3)\n    print("RAN:", out.stdout.decode().strip())\nexcept Exception as e:\n    print("BLOCKED")`
  );
  check(
    "/tmp is writable but not executable (noexec)",
    (tmpExecResult.output || "").includes("BLOCKED"),
    tmpExecResult.output
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log("Failed:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Security check itself failed to run:", err.message);
  process.exit(1);
});
