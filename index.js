/**
 * Sandbox IDE - Tier 0/1 Orchestrator
 *
 * Spins up a fresh, locked-down Docker container per code run, enforces
 * resource + time limits, captures output, and tears the container down.
 *
 * Deliberately simple: no pre-warmed pool yet (that's a Tier 1/2 optimization
 * once cold-start latency actually matters to real users), no network mocking
 * yet (Tier 2). Network is fully disabled by default for safety.
 */

const express = require("express");
const Docker = require("dockerode");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

const docker = new Docker(); // connects to local Docker daemon via socket

// ---- Config -----------------------------------------------------------

const LANGUAGES = {
  python: {
    image: "sandbox-python",
    filename: "code.py",
    cmd: (filePath) => ["python3", filePath],
  },
  node: {
    image: "sandbox-node",
    filename: "code.js",
    cmd: (filePath) => ["node", filePath],
  },
};

// Simple heuristic auto-detection (FR2). This is intentionally basic for v1 —
// it only affects resource allocation, not behavior, so a wrong guess is cheap.
const HEAVY_WORKLOAD_MARKERS = [
  "pandas", "numpy", "torch", "tensorflow", "sklearn", "cv2",
];

function detectProfile(code) {
  const isHeavy = HEAVY_WORKLOAD_MARKERS.some((marker) => code.includes(marker));
  return {
    memory: isHeavy ? 512 * 1024 * 1024 : 128 * 1024 * 1024, // bytes
    nanoCpus: isHeavy ? 1_000_000_000 : 500_000_000, // 1.0 vs 0.5 CPU
    label: isHeavy ? "data-heavy" : "standard",
  };
}

const RUN_TIMEOUT_MS = 8000; // wall-clock kill switch (NFR1/NFR3)

// ---- Core run logic -----------------------------------------------------

async function runInSandbox(language, code) {
  const langConfig = LANGUAGES[language];
  if (!langConfig) {
    return { error: `Unsupported language: ${language}` };
  }

  const profile = detectProfile(code);

  // Write user code to a temp dir we bind-mount read-only into the container.
  const runId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), `sandbox-${runId}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const hostFilePath = path.join(tmpDir, langConfig.filename);
  const containerFilePath = `/home/sandboxuser/${langConfig.filename}`;
  await fs.writeFile(hostFilePath, code, "utf8");

  let container;
  try {
    container = await docker.createContainer({
      Image: langConfig.image,
      Cmd: langConfig.cmd(containerFilePath),
      HostConfig: {
        Memory: profile.memory,
        NanoCpus: profile.nanoCpus,
        NetworkMode: "none", // no network by default — see FR3 note below
        Binds: [`${tmpDir}:/home/sandboxuser:ro`],
        AutoRemove: false, // we remove manually after reading logs
      },
      Tty: false,
    });

    await container.start();

    // Race the container finishing against our hard timeout.
    const waitPromise = container.wait();
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), RUN_TIMEOUT_MS)
    );

    const result = await Promise.race([waitPromise, timeoutPromise]);

    let timedOut = false;
    if (result && result.timedOut) {
      timedOut = true;
      try {
        await container.kill();
      } catch (_) {
        /* already stopped, ignore */
      }
    }

    const logBuffer = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: false,
    });
    const output = demuxLogs(logBuffer);

    return {
      output: output.stdout,
      errorOutput: output.stderr,
      timedOut,
      profile: profile.label,
      // FR3: plain-English note. Real syscall/network-denial explanation is a
      // Tier 2 item (needs deeper log/interception work) — for now we surface
      // the one thing we *do* know for certain: network is always off.
      note: "Network access is disabled in this sandbox by default.",
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (_) {
        /* ignore cleanup errors */
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Docker multiplexes stdout/stderr into one stream with an 8-byte header per
// frame. This splits them back apart into readable text.
function demuxLogs(buffer) {
  let stdout = "";
  let stderr = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const payload = buffer.slice(offset + 8, offset + 8 + size).toString("utf8");
    if (streamType === 1) stdout += payload;
    else if (streamType === 2) stderr += payload;
    offset += 8 + size;
  }
  return { stdout, stderr };
}

// ---- Routes ---------------------------------------------------------------

// Very basic per-IP rate limiting (Tier 1 requirement) — intentionally simple
// in-memory version; swap for something durable before real public exposure.
const rateLimitWindow = new Map(); // ip -> [timestamps]
const RATE_LIMIT_MAX = 20; // runs per window
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateLimitWindow.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  rateLimitWindow.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

app.post("/run", async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
  }

  const { language, code } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing 'code' string in request body." });
  }
  if (!LANGUAGES[language]) {
    return res.status(400).json({ error: `Unsupported language '${language}'.` });
  }

  try {
    const result = await runInSandbox(language, code);
    res.json(result);
  } catch (err) {
    console.error("Sandbox run failed:", err);
    res.status(500).json({ error: "Internal error running sandbox." });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Sandbox IDE orchestrator listening on http://localhost:${PORT}`);
});
