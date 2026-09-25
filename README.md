# Sandbox IDE — Tier 0/1

A light, self-hosted sandbox that runs Python or Node.js code in isolated,
resource-limited Docker containers, with a minimal Monaco-based editor.

## What this is (and isn't) yet

- ✅ Isolated code execution (Python, Node.js), no network access, memory/CPU/time limits
- ✅ Simple auto-detection of "heavy" workloads (pandas/numpy/torch/etc.) to grant more resources
- ✅ Basic per-IP rate limiting
- ❌ No accounts, no persistence, no API mocking, no AI diagnostics yet — these are Tier 2/3

## Prerequisites

- Docker installed and running (Docker Desktop on Windows/Mac, or Docker Engine on Linux)
- Node.js 18+ installed (for the orchestrator server)

## Setup

1. **Build the sandbox images** (one-time, from the project root):

   ```bash
   docker build -t sandbox-python -f docker/python.Dockerfile docker/
   docker build -t sandbox-node -f docker/node.Dockerfile docker/
   ```

2. **Install server dependencies:**

   ```bash
   cd server
   npm install
   ```

3. **Run the server:**

   ```bash
   npm start
   ```

4. **Open the IDE:**

   Visit `http://localhost:4000` in your browser. Write some code, hit Run.

## How it works

Each time you hit Run, the server:
1. Writes your code to a temp file on the host
2. Starts a brand-new container from the matching image, with that file
   bind-mounted in read-only, network disabled, and memory/CPU limits set
3. Waits for it to finish (or kills it after 8 seconds)
4. Reads back stdout/stderr, deletes the container and temp file, and
   returns the output

Nothing persists between runs — every run starts from a clean container.

## Known limitations (by design, for now)

- **No pre-warmed container pool yet** — each run pays the cost of starting
  a fresh container, so expect roughly 1–3 seconds of overhead. Worth
  optimizing once this is proven useful, not before.
- **Network is always off** — code that tries to call an external API will
  fail. Mocking those calls is a Tier 2 feature.
- **No syscall-level explanation of failures** — if code fails for a reason
  other than the timeout or a normal runtime error, you'll see whatever
  Docker/the runtime itself reports. Turning that into a friendlier
  plain-English diagnosis is future work.
- **Only tested for personal/local use** — before exposing this to anyone
  else (even on your LAN), review the rate limiting and resource limits for
  your own hardware's actual capacity.

## Next steps (Tier 1 → Tier 2)

- Pre-warmed container pool to cut cold-start latency
- Persistent (opt-in) sandboxes
- Basic API mocking library for common services (payments, auth, webhooks)
- Move from in-memory rate limiting to something durable if exposed publicly
