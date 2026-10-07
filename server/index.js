/**
 * Sandbox IDE - Orchestrator (Tiers 1-7)
 */

const express = require("express");
const Docker = require("dockerode");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const selfsigned = require("selfsigned");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

const docker = new Docker();

const LANGUAGES = {
  python: {
    image: "sandbox-python",
    filename: "code.py",
    stdinFilename: "stdin.txt",
    homeDir: "/home/sandboxuser",
    cmd: (filePath) => ["python3", filePath],
    shellCmd: (filePath, stdinPath) => `python3 ${filePath} < ${stdinPath}`,
    poolCmd: ["sleep", "infinity"],
    env: ["PYTHONDONTWRITEBYTECODE=1"],
  },
  node: {
    image: "sandbox-node",
    filename: "code.js",
    stdinFilename: "stdin.txt",
    homeDir: "/home/node",
    cmd: (filePath) => ["node", filePath],
    shellCmd: (filePath, stdinPath) => `node ${filePath} < ${stdinPath}`,
    poolCmd: ["sleep", "infinity"],
    env: [],
  },
  dart: {
    image: "sandbox-dart",
    filename: "code.dart",
    stdinFilename: "stdin.txt",
    homeDir: "/home/sandboxuser",
    cmd: (filePath) => ["dart", "run", filePath],
    shellCmd: (filePath, stdinPath) => `dart run ${filePath} < ${stdinPath}`,
    poolCmd: null,
    env: ["DART_DISABLE_ANALYTICS=true", "HOME=/tmp"],
  },
  go: {
    image: "sandbox-go",
    filename: "code.go",
    stdinFilename: "stdin.txt",
    homeDir: "/home/sandboxuser",
    cmd: (filePath) => ["go", "run", filePath],
    shellCmd: (filePath, stdinPath) => `go run ${filePath} < ${stdinPath}`,
    poolCmd: null,
    env: [
      "GOCACHE=/tmp/gocache",
      "GOPATH=/tmp/gopath",
      "GOTOOLCHAIN=local",
      "GOPROXY=off",
      "GOSUMDB=off",
    ],
    needsExecTmp: true,
    resourceOverride: { memory: 256 * 1024 * 1024, nanoCpus: 2_000_000_000 },
    timeoutMs: 45000,
  },

  c: {
    image: "sandbox-c",
    filename: "code.c",
    stdinFilename: "stdin.txt",
    homeDir: "/home/sandboxuser",
    cmd: (filePath) => ["sh", "-c", `gcc ${filePath} -o /tmp/a.out && /tmp/a.out`],
    shellCmd: (filePath, stdinPath) => `gcc ${filePath} -o /tmp/a.out && /tmp/a.out < ${stdinPath}`,
    poolCmd: null,
    env: [],
    needsExecTmp: true,
  },

  // Reuses the sandbox-c image: g++ ships alongside gcc in that same
  // image, so no new Docker image or extra disk space is needed.
  cpp: {
    image: "sandbox-c",
    filename: "code.cpp",
    stdinFilename: "stdin.txt",
    homeDir: "/home/sandboxuser",
    cmd: (filePath) => ["sh", "-c", `g++ ${filePath} -o /tmp/a.out && /tmp/a.out`],
    shellCmd: (filePath, stdinPath) => `g++ ${filePath} -o /tmp/a.out && /tmp/a.out < ${stdinPath}`,
    poolCmd: null,
    env: [],
    needsExecTmp: true,
  },

  // Reuses the sandbox-node image (rebuilt from the updated node.Dockerfile,
  // which adds a global "typescript" install). Compiles offline with tsc,
  // then runs the emitted JS with node — no network access needed at run time.
  typescript: {
    image: "sandbox-node",
    filename: "code.ts",
    stdinFilename: "stdin.txt",
    homeDir: "/home/node",
    cmd: (filePath) => ["sh", "-c", `tsc ${filePath} --outDir /tmp --target ES2020 && node /tmp/code.js`],
    shellCmd: (filePath, stdinPath) => `tsc ${filePath} --outDir /tmp --target ES2020 && node /tmp/code.js < ${stdinPath}`,
    poolCmd: null,
    env: [],
    needsExecTmp: true,
  },
};

const HEAVY_WORKLOAD_MARKERS = [
  "pandas", "numpy", "torch", "tensorflow", "sklearn", "cv2",
];

function detectProfile(code) {
  const isHeavy = HEAVY_WORKLOAD_MARKERS.some((marker) => code.includes(marker));
  return {
    memory: isHeavy ? 512 * 1024 * 1024 : 128 * 1024 * 1024,
    nanoCpus: isHeavy ? 1_000_000_000 : 500_000_000,
    label: isHeavy ? "data-heavy" : "standard",
  };
}

const RUN_TIMEOUT_MS = 8000;
const POOL_SIZE = Number(process.env.POOL_SIZE || 2);
const POOL_ENABLED = process.env.POOL_ENABLED === "true";

function hardenedHostConfig(extra) {
  return {
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    PidsLimit: 64,
    ReadonlyRootfs: true,
    Tmpfs: { "/tmp": "rw,size=32m,noexec" },
    NetworkMode: "none",
    AutoRemove: false,
    ...extra,
  };
}

const LOG_PATH = path.join(__dirname, "data", "runs.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

async function logRun(entry) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    try {
      const stat = await fs.stat(LOG_PATH);
      if (stat.size > LOG_MAX_BYTES) {
        await fs.rename(LOG_PATH, `${LOG_PATH}.${Date.now()}.old`);
      }
    } catch (_) {}
    await fs.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("Failed to write run log:", err.message);
  }
}

const pools = {};
const poolRefilling = {};

async function createIdleContainer(language) {
  const langConfig = LANGUAGES[language];
  const container = await docker.createContainer({
    Image: langConfig.image,
    Cmd: langConfig.poolCmd,
    Env: langConfig.env,
    HostConfig: hardenedHostConfig({
      Memory: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
    }),
    Tty: false,
  });
  await container.start();
  return container;
}

async function refillPool(language) {
  if (!POOL_ENABLED || !LANGUAGES[language].poolCmd) return;
  pools[language] = pools[language] || [];
  poolRefilling[language] = poolRefilling[language] || 0;
  const needed = POOL_SIZE - pools[language].length - poolRefilling[language];
  for (let i = 0; i < needed; i++) {
    poolRefilling[language]++;
    createIdleContainer(language)
      .then((c) => { pools[language].push(c); })
      .catch((err) => { console.error(`Pool refill failed for ${language}:`, err.message); })
      .finally(() => { poolRefilling[language]--; });
  }
}

function initPools() {
  if (!POOL_ENABLED) {
    console.log("Container pool disabled (POOL_ENABLED=false).");
    return;
  }
  for (const language of Object.keys(LANGUAGES)) {
    if (LANGUAGES[language].poolCmd) refillPool(language);
  }
}

function takeFromPool(language) {
  const pool = pools[language];
  if (!pool || pool.length === 0) return null;
  const container = pool.shift();
  refillPool(language);
  return container;
}

async function execAndCollect(container, cmd, stdinInput) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true });

  const stdoutChunks = [];
  const stderrChunks = [];
  docker.modem.demuxStream(
    stream,
    { write: (chunk) => stdoutChunks.push(chunk) },
    { write: (chunk) => stderrChunks.push(chunk) }
  );

  stream.write(stdinInput || "");
  stream.end();

  await new Promise((resolve) => stream.on("end", resolve));
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  const inspectResult = await exec.inspect();
  return { stdout, stderr, exitCode: inspectResult.ExitCode };
}

async function runInPool(language, code, stdinInput) {
  const langConfig = LANGUAGES[language];
  const container = takeFromPool(language);
  if (!container) return null;

  const startedAt = Date.now();
  const containerFilePath = `${langConfig.homeDir}/${langConfig.filename}`;

  try {
    await execAndCollect(container, ["sh", "-c", `cat > ${containerFilePath}`], code);

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), langConfig.timeoutMs || RUN_TIMEOUT_MS)
    );
    const execPromise = execAndCollect(container, langConfig.cmd(containerFilePath), stdinInput);

    const result = await Promise.race([execPromise, timeoutPromise]);

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let exitCode = null;

    if (result && result.timedOut) {
      timedOut = true;
      try { await container.kill(); } catch (_) {}
    } else {
      ({ stdout, stderr, exitCode } = result);
    }

    let oomKilled = false;
    try {
      const inspectData = await container.inspect();
      oomKilled = Boolean(inspectData.State && inspectData.State.OOMKilled);
    } catch (_) {}

    return { stdout, stderr, timedOut, exitCode, oomKilled, durationMs: Date.now() - startedAt };
  } finally {
    try { await container.remove({ force: true }); } catch (_) {}
  }
}

async function runColdStart(language, code, stdinInput = "") {
  const langConfig = LANGUAGES[language];
  const profile = detectProfile(code);
  const startedAt = Date.now();

  const runId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), `sandbox-${runId}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const hostFilePath = path.join(tmpDir, langConfig.filename);
  const hostStdinPath = path.join(tmpDir, langConfig.stdinFilename);
  const containerFilePath = `${langConfig.homeDir}/${langConfig.filename}`;
  const containerStdinPath = `${langConfig.homeDir}/${langConfig.stdinFilename}`;

  // Languages that compile-and-run (Go, C) execute a binary from /tmp.
  // Docker Desktop on Windows/WSL2 can be unreliable about tmpfs exec
  // flags, so for those languages we bind-mount a real host folder for
  // /tmp instead of using an in-memory tmpfs.
  let execTmpHostDir = null;
  if (langConfig.needsExecTmp) {
    execTmpHostDir = path.join(tmpDir, "exectmp");
    await fs.mkdir(execTmpHostDir, { recursive: true });
  }
  await fs.writeFile(hostFilePath, code, "utf8");
  await fs.writeFile(hostStdinPath, stdinInput || "", "utf8");

  let container;
  try {
    container = await docker.createContainer({
      Image: langConfig.image,
      Cmd: ["sh", "-c", langConfig.shellCmd(containerFilePath, containerStdinPath)],
      Env: langConfig.env,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: hardenedHostConfig({
        Memory: (langConfig.resourceOverride && langConfig.resourceOverride.memory) || profile.memory,
        NanoCpus: (langConfig.resourceOverride && langConfig.resourceOverride.nanoCpus) || profile.nanoCpus,
        Binds: [
          `${hostFilePath}:${containerFilePath}:ro`,
          `${hostStdinPath}:${containerStdinPath}:ro`,
          ...(execTmpHostDir ? [`${execTmpHostDir}:/tmp:rw`] : []),
        ],
        ...(execTmpHostDir ? { Tmpfs: {} } : {}),
      }),
      Tty: false,
    });

    await container.start();

    const effectiveTimeout = langConfig.timeoutMs || RUN_TIMEOUT_MS;
    const waitPromise = container.wait();
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), effectiveTimeout)
    );
    const result = await Promise.race([waitPromise, timeoutPromise]);

    let timedOut = false;
    let exitCode = null;
    if (result && result.timedOut) {
      timedOut = true;
      try { await container.kill(); } catch (_) {}
    } else if (result) {
      exitCode = typeof result.StatusCode === "number" ? result.StatusCode : null;
    }

    let oomKilled = false;
    try {
      const inspectData = await container.inspect();
      oomKilled = Boolean(inspectData.State && inspectData.State.OOMKilled);
    } catch (_) {}

    const logBuffer = await container.logs({ stdout: true, stderr: true, timestamps: false });
    const output = demuxLogs(logBuffer);

    return {
      stdout: output.stdout,
      stderr: output.stderr,
      timedOut,
      exitCode,
      oomKilled,
      durationMs: Date.now() - startedAt,
      profile: profile.label,
      viaPool: false,
    };
  } finally {
    if (container) {
      try { await container.remove({ force: true }); } catch (_) {}
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runInSandbox(language, code, stdinInput, ip) {
  const langConfig = LANGUAGES[language];
  if (!langConfig) return { error: `Unsupported language: ${language}` };

  const profile = detectProfile(code);
  let raw;
  let viaPool = false;

  if (POOL_ENABLED && profile.label !== "data-heavy") {
    try {
      const poolResult = await runInPool(language, code, stdinInput);
      if (poolResult) {
        raw = { ...poolResult, profile: profile.label };
        viaPool = true;
      }
    } catch (err) {
      console.error(`Pool run failed for ${language}, falling back to cold start:`, err.message);
    }
  }

  if (!raw) {
    raw = await runColdStart(language, code, stdinInput);
  }

  const notes = ["Network access is disabled in this sandbox by default."];
  if (raw.oomKilled) {
    notes.unshift(`Run exceeded its memory limit (${Math.round(profile.memory / (1024 * 1024))}MB) and was stopped.`);
  }
  const friendly = translateError(raw.stderr);
  if (friendly) notes.unshift(friendly);

  const response = {
    output: raw.stdout,
    errorOutput: raw.stderr,
    timedOut: raw.timedOut,
    exitCode: raw.exitCode,
    durationMs: raw.durationMs,
    oomKilled: raw.oomKilled,
    profile: profile.label,
    viaPool,
    note: notes.join(" "),
  };

  logRun({
    ts: new Date().toISOString(),
    ip,
    language,
    durationMs: raw.durationMs,
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    oomKilled: raw.oomKilled,
    viaPool,
    profile: profile.label,
  });

  return response;
}

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

function translateError(stderr) {
  if (!stderr) return null;
  if (/ModuleNotFoundError|Cannot find module/.test(stderr)) {
    return "That package isn't in the sandbox's pre-installed set (Python: requests, numpy; Node: axios, lodash).";
  }
  if (/SyntaxError/.test(stderr)) {
    return "There's a syntax error -- check the line number in the error below.";
  }
  if (/Network is unreachable|ENETUNREACH|ECONNREFUSED|urlopen error|getaddrinfo/.test(stderr)) {
    return "That looks like a blocked network call -- this sandbox has no network access by default.";
  }
  if (/Permission denied/.test(stderr)) {
    return "Permission denied -- the sandbox runs as a restricted, non-root user by design.";
  }
  return null;
}

const rateLimitWindow = new Map();
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 20);
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (rateLimitWindow.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  rateLimitWindow.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

const BANS_PATH = path.join(__dirname, "data", "bans.json");
const violationCounts = new Map();
const BAN_THRESHOLD = Number(process.env.BAN_THRESHOLD || 3);
const BAN_DURATION_MS = Number(process.env.BAN_DURATION_MINUTES || 15) * 60 * 1000;
let bannedIps = {};

async function loadBans() {
  try {
    bannedIps = JSON.parse(await fs.readFile(BANS_PATH, "utf8"));
  } catch (_) {
    bannedIps = {};
  }
}

async function saveBans() {
  try {
    await fs.mkdir(path.dirname(BANS_PATH), { recursive: true });
    await fs.writeFile(BANS_PATH, JSON.stringify(bannedIps, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist ban list:", err.message);
  }
}

function isBanned(ip) {
  const until = bannedIps[ip];
  if (!until) return false;
  if (Date.now() > until) {
    delete bannedIps[ip];
    saveBans();
    return false;
  }
  return true;
}

function recordViolation(ip) {
  const count = (violationCounts.get(ip) || 0) + 1;
  violationCounts.set(ip, count);
  if (count >= BAN_THRESHOLD) {
    bannedIps[ip] = Date.now() + BAN_DURATION_MS;
    violationCounts.delete(ip);
    saveBans();
    console.log(`IP ${ip} banned for ${BAN_DURATION_MS / 60000} minutes after repeated rate-limit violations.`);
  }
}

app.use((req, res, next) => {
  if (isBanned(req.ip)) {
    return res.status(403).json({ error: "This IP is temporarily banned for repeated abuse." });
  }
  next();
});

function rateLimitGuard(req, res, next) {
  if (isRateLimited(req.ip)) {
    recordViolation(req.ip);
    return res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
  }
  next();
}

const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS || 10);
let currentRuns = 0;

function requireAuth(req, res, next) {
  const token = process.env.SANDBOX_TOKEN;
  if (!token) return next();
  const header = req.headers.authorization || "";
  if (header === `Bearer ${token}`) return next();
  return res.status(401).json({ error: "Missing or invalid Authorization header." });
}

// Turns a raw error (often a dockerode/Docker-API error) into a specific,
// human-readable message instead of a dead-end "Internal error". Falls
// back to a trimmed version of the real error rather than hiding it.
function classifySandboxError(err, language) {
  const raw = String((err && err.message) || err || "");

  if (/ECONNREFUSED|dockerDesktopLinuxEngine|docker.*(daemon|engine)|pipe[\\/]docker/i.test(raw)) {
    return "Can't reach Docker. Make sure Docker Desktop is running, then try again.";
  }
  if (/no such image/i.test(raw)) {
    return `The "${language}" sandbox image isn't built yet. Build it and try again.`;
  }
  if (/duplicate mount point/i.test(raw)) {
    return "Sandbox container configuration error (duplicate mount). This is a bug — please report it.";
  }
  if (/timed out|timeout/i.test(raw)) {
    return "Your code took too long to run and was stopped.";
  }
  if (/permission denied/i.test(raw)) {
    return "Sandbox permission error while starting the container. This is a bug — please report it.";
  }
  if (raw) {
    return `Sandbox error: ${raw.slice(0, 200)}`;
  }
  return "Internal error running sandbox.";
}

app.post("/run", requireAuth, rateLimitGuard, async (req, res) => {
  const ip = req.ip;
  if (currentRuns >= MAX_CONCURRENT_RUNS) {
    return res.status(429).json({ error: "Server is busy. Try again shortly." });
  }

  const { language, code, stdin } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Missing 'code' string in request body." });
  }
  if (!LANGUAGES[language]) {
    return res.status(400).json({ error: `Unsupported language '${language}'.` });
  }

  currentRuns++;
  try {
    const result = await runInSandbox(language, code, stdin, ip);
    res.json(result);
  } catch (err) {
    console.error("Sandbox run failed:", err);
    res.status(500).json({ error: classifySandboxError(err, language) });
  } finally {
    currentRuns--;
  }
});

// Crash isolation: a bug outside the /run route's own try/catch (e.g. in a
// Docker event-stream callback) used to be able to kill the whole server,
// taking down every user's session. Log it and keep running instead.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server stayed up):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server stayed up):", reason);
});

const SNIPPETS_PATH = path.join(__dirname, "data", "snippets.json");

async function readSnippets() {
  try {
    const raw = await fs.readFile(SNIPPETS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

async function writeSnippets(snippets) {
  await fs.mkdir(path.dirname(SNIPPETS_PATH), { recursive: true });
  await fs.writeFile(SNIPPETS_PATH, JSON.stringify(snippets, null, 2), "utf8");
}

app.post("/save", requireAuth, rateLimitGuard, async (req, res) => {
  const { language, code, name } = req.body || {};
  if (!code || typeof code !== "string" || !LANGUAGES[language]) {
    return res.status(400).json({ error: "Missing or invalid 'language'/'code'." });
  }
  const id = crypto.randomUUID().slice(0, 8);
  const snippets = await readSnippets();
  snippets[id] = {
    language,
    code,
    name: (typeof name === "string" && name.trim()) ? name.trim().slice(0, 80) : "Untitled project",
    savedAt: new Date().toISOString(),
  };
  await writeSnippets(snippets);
  res.json({ id });
});

// Lists saved projects (newest first) so the frontend can offer a picker
// instead of requiring people to remember or paste a raw id/link.
app.get("/projects", rateLimitGuard, async (req, res) => {
  const snippets = await readSnippets();
  const list = Object.entries(snippets)
    .map(([id, s]) => ({
      id,
      // Saves made before named projects existed have no "name" field at
      // all — label those "Previous run" so they read as legacy entries
      // rather than someone's save they forgot to name.
      name: s.name || "Previous run",
      language: s.language,
      savedAt: s.savedAt,
    }))
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  res.json(list);
});

// Deletes a single saved project (the trash icon in the Open picker).
app.delete("/projects/:id", requireAuth, rateLimitGuard, async (req, res) => {
  const snippets = await readSnippets();
  if (!snippets[req.params.id]) {
    return res.status(404).json({ error: "No saved project with that id." });
  }
  delete snippets[req.params.id];
  await writeSnippets(snippets);
  res.json({ ok: true });
});

// Clears every saved project at once ("Clear all" in the Open picker).
app.delete("/projects", requireAuth, rateLimitGuard, async (req, res) => {
  await writeSnippets({});
  res.json({ ok: true });
});

app.get("/load/:id", rateLimitGuard, async (req, res) => {
  const snippets = await readSnippets();
  const snippet = snippets[req.params.id];
  if (!snippet) {
    return res.status(404).json({ error: "No saved snippet with that id." });
  }
  res.json(snippet);
});

app.get("/stats", rateLimitGuard, async (req, res) => {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf8").catch(() => "");
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const byLanguage = {};
    let totalDuration = 0;
    let timeouts = 0;
    let oomKills = 0;
    let viaPoolCount = 0;
    for (const entry of lines) {
      byLanguage[entry.language] = (byLanguage[entry.language] || 0) + 1;
      totalDuration += entry.durationMs || 0;
      if (entry.timedOut) timeouts++;
      if (entry.oomKilled) oomKills++;
      if (entry.viaPool) viaPoolCount++;
    }
    res.json({
      totalRuns: lines.length,
      byLanguage,
      avgDurationMs: lines.length ? Math.round(totalDuration / lines.length) : 0,
      timeouts,
      oomKills,
      viaPoolCount,
      poolStatus: Object.fromEntries(
        Object.keys(LANGUAGES).map((lang) => [lang, (pools[lang] || []).length])
      ),
    });
  } catch (err) {
    res.status(500).json({ error: "Couldn't read stats." });
  }
});

const PORT = process.env.PORT || 4000;
const HTTPS_ENABLED = process.env.SANDBOX_HTTPS === "true";
const HTTPS_PORT = process.env.HTTPS_PORT || 4443;
const CERT_DIR = path.join(__dirname, "data", "certs");

async function getOrCreateSelfSignedCert() {
  const certPath = path.join(CERT_DIR, "cert.pem");
  const keyPath = path.join(CERT_DIR, "key.pem");
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, "utf8"),
      fs.readFile(keyPath, "utf8"),
    ]);
    return { cert, key };
  } catch (_) {
    const pems = selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 825 });
    await fs.mkdir(CERT_DIR, { recursive: true });
    await fs.writeFile(certPath, pems.cert, "utf8");
    await fs.writeFile(keyPath, pems.private, "utf8");
    return { cert: pems.cert, key: pems.private };
  }
}

async function start() {
  await loadBans();

  app.listen(PORT, () => {
    console.log(`Sandbox IDE (HTTP) listening on http://localhost:${PORT}`);
    initPools();
  });

  if (HTTPS_ENABLED) {
    const { cert, key } = await getOrCreateSelfSignedCert();
    https.createServer({ cert, key }, app).listen(HTTPS_PORT, () => {
      console.log(`Sandbox IDE (HTTPS, self-signed) listening on https://localhost:${HTTPS_PORT}`);
    });
  }
}

start();
