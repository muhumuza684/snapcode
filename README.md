# Sandbox IDE

A light, self-hosted sandbox that runs code in isolated, resource-limited
Docker containers, with a minimal Monaco-based editor. Built by BrytMa Tech UG.

## What's included (Tiers 1–5)

- **Tier 1 — Isolation hardening:** only the single code file is bind-mounted
  into each container (not a whole host directory), real memory-limit
  (OOM) detection with a plain-English message, confirmed working timeout
  kill-switch.
- **Tier 2 — Language expansion:** Python, Node.js, and Dart.
- **Tier 3 — Package support:** Python images ship with `requests` + `numpy`
  pre-installed; Node images ship with `axios` + `lodash`. Not arbitrary
  `pip`/`npm install` per run — network is off at runtime, so packages are
  baked into the image at build time instead.
- **Tier 4 — Input & observability:** code can read stdin (a textarea in the
  UI), and every run reports back execution time and exit code, not just
  raw output text.
- **Tier 5 — Persistence (opt-in):** a Save button stores the current
  snippet to a local JSON file and gives you a shareable `?id=` link to
  reload it later. Nothing is saved unless you click Save.

## Prerequisites

- Docker installed and running (Docker Desktop on Windows/Mac, or Docker
  Engine on Linux)
- Node.js 18+ installed (for the orchestrator server)

## Setup

1. **Build the sandbox images** (from the project root):

   ```bash
   docker build -t sandbox-python -f docker/python.Dockerfile docker/
   docker build -t sandbox-node -f docker/node.Dockerfile docker/
   docker build -t sandbox-dart -f docker/dart.Dockerfile docker/
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

4. **Open the IDE:** visit `http://localhost:4000`.

## How it works

Each Run:
1. Writes your code to a temp file on the host
2. Starts a brand-new container from the matching language image, with
   *only that file* bind-mounted in read-only, network disabled, and
   memory/CPU limits set based on a simple heuristic (heavier limits if the
   code imports something like numpy/pandas/torch)
3. Feeds any stdin you provided, then waits for the container to finish (or
   kills it after 8 seconds)
4. Reads back stdout/stderr, exit code, and timing; checks whether it was
   OOM-killed; removes the container and temp file

Nothing persists between runs unless you explicitly click **Save**.

## Verifying it's a real sandbox, not a dummy

These are worth re-running any time you change the Dockerfiles or
`server/index.js`, to confirm isolation still actually holds:

- **Network is blocked:** try `urllib.request.urlopen(...)` (Python) — should
  raise a connection error, not succeed.
- **Filesystem is isolated:** `os.listdir("/")` should show a container's
  root, never your host's real folders.
- **Memory limit is enforced:** allocating ~300MB against the 128MB default
  cap should crash the run (the response's `oomKilled` will be `true`).
- **Timeout is enforced:** an infinite loop should stop after ~8 seconds
  with `timedOut: true`.
- **Runs don't share state:** writing a file in one run, then checking for
  it in the next, should show it's gone — every run starts from scratch.

## Known limitations (by design, for now)

- **No pre-warmed container pool** — each run pays ~1–3s of container
  startup overhead. Worth optimizing once this is proven useful.
- **Network is always off** — no API mocking yet; that's a future tier.
- **Persistence is a single JSON file** — fine for personal/small use, not
  built for concurrent writers or large scale.
- **Rate limiting is in-memory** — resets on server restart, not distributed
  across multiple server instances.
- **Only tested for personal/local use** — review resource limits for your
  own hardware before exposing this beyond your own machine.

## Next steps (future tiers)

- Pre-warmed container pool to cut cold-start latency
- API mocking for common services (payments, auth, webhooks)
- Accounts, GPU-backed ML tier, collaboration, AI diagnostics

## Tier 6 — Usability & confidence

- **One-command setup:** run `.\setup.ps1` (Windows) or `./setup.sh`
  (Mac/Linux) from the project root — builds all three images and installs
  server dependencies in one go.
- **Examples dropdown:** pick a language, then pick an example (hello world,
  stdin, pre-installed packages, isolation check) to load real working code
  instead of starting from a blank editor.
- **Friendlier errors:** common failures (missing package, syntax error,
  blocked network call, permission denied) now get a plain-English line
  added on top of the raw error — the raw error is never hidden, just
  explained.
- **Automated isolation checks:** `node tests/verify-sandbox.js` (with the
  server running) re-runs the network/memory/timeout/persistence/package/
  stdin checks automatically instead of by hand in the browser.
- **Concurrency check:** `node tests/concurrency-test.js` fires a slow and a
  fast run at once and confirms they don't block each other.

### Still deliberately not built (see conversation for the full reasoning)

Abuse protection at scale, a real security audit, monitoring/logging, a
full automated test suite, and HTTPS/auth are all real gaps — but they only
matter once this is exposed beyond your own machine. Revisit them if/when
that changes.

## Tier 7 — Pool, hardening, logging, abuse protection, auth

- **Pre-warmed pool:** Python and Node keep 2 idle, already-started
  containers ready at all times (configurable via `POOL_SIZE`). A run uses
  one via `docker exec` instead of paying full container-creation cost, then
  that container is destroyed and replaced — so "every run starts fresh"
  still holds. Heavy workloads (numpy/pandas/etc.) always cold-start, since
  pool containers only carry standard resource limits. If pool execution
  fails for any reason, it falls back to the normal cold-start path
  automatically. Disable with `POOL_ENABLED=false`.
- **Broader security hardening**, applied to every container (pooled or
  cold-started): all Linux capabilities dropped, `no-new-privileges` set,
  a 64-process PID limit (fork-bomb protection), and a read-only root
  filesystem (only `/tmp` is writable, and non-executable).
- **Structured run logging:** every run appends a line to
  `server/data/runs.log` (timestamp, IP, language, duration, exit code,
  timeout/OOM flags, whether it used the pool). Rotates automatically past
  5MB. Not shipped anywhere external — it's a local file only.
- **`GET /stats`:** aggregate counts (total runs, by language, average
  duration, timeouts, OOM kills, current pool sizes) — a quick way to see
  what's actually happened without reading the raw log.
- **Global concurrency cap:** `MAX_CONCURRENT_RUNS` (default 10) limits how
  many runs can execute at once regardless of which IP they're from, on top
  of the existing per-IP rate limit (`RATE_LIMIT_MAX`, default 20/minute).
- **Optional auth:** set the `SANDBOX_TOKEN` environment variable to
  require `Authorization: Bearer <token>` on `/run` and `/save`. Unset by
  default — no friction for local/personal use.
- **`node tests/security-check.js`:** automated checks for the hardening
  flags above (read-only filesystem, dropped capabilities, PID limit,
  Docker socket not exposed). Not a substitute for a real audit by someone
  whose job is breaking sandboxes — but catches obvious regressions.

### If you expose this beyond localhost

This project deliberately doesn't build its own TLS/HTTPS — that's a
solved problem better handled by a proven reverse proxy sitting in front of
it, rather than reinventing certificate management here. The simplest
options:
- **Caddy** — `caddy reverse-proxy --to localhost:4000` gives you automatic
  HTTPS with almost no configuration.
- **ngrok** — `ngrok http 4000` for a quick, temporary public HTTPS URL
  without touching your own network setup at all.

Pair either with `SANDBOX_TOKEN` set, so the exposed endpoint isn't wide
open.

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Server port |
| `POOL_ENABLED` | `true` | Turn the pre-warmed pool on/off |
| `POOL_SIZE` | `2` | Idle containers kept per pool-eligible language |
| `RATE_LIMIT_MAX` | `20` | Max runs per IP per minute |
| `MAX_CONCURRENT_RUNS` | `10` | Max runs executing at once, across all IPs |
| `SANDBOX_TOKEN` | unset | If set, required as a Bearer token on `/run` and `/save` |

## Tier 7.1 — closing the remaining gaps (as far as actually possible)

### Abuse protection — now covers every endpoint, with persisted bans

- `/run`, `/save`, `/load/:id`, and `/stats` are all rate-limited now (only
  `/run` and `/save` were before).
- Repeated rate-limit violations (`BAN_THRESHOLD`, default 3) escalate to a
  temporary IP ban (`BAN_DURATION_MINUTES`, default 15), persisted to
  `server/data/bans.json` so it survives a server restart.
- **Honest limit:** this is still a single Node process with in-memory +
  local-file state. It has no way to coordinate across multiple server
  instances or machines. Genuine "at scale" abuse protection (surviving a
  real botnet, distributed across load-balanced servers) needs a shared
  store like Redis — that's an infrastructure decision for if/when this
  ever needs to run on more than one machine, not something a single file
  can provide.

### HTTPS — real encryption, self-signed

- Set `SANDBOX_HTTPS=true` and the server generates its own self-signed
  certificate on first run (`server/data/certs/`) and serves HTTPS on
  `HTTPS_PORT` (default 4443) alongside the existing HTTP port.
- **Honest limit:** your browser will show a "not trusted" warning for this
  certificate. That's not a bug — trust requires a certificate signed by a
  recognized authority, which requires a real, owned domain name. Nothing
  running on your machine can generate that on its own. If you get a domain
  later, point Caddy or Let's Encrypt at it instead (see the earlier
  section) and this self-signed setup becomes unnecessary.

### Security audit — expanded self-checks, not a substitute for a real one

`tests/security-check.js` now also checks: code runs as a non-root user,
and `/tmp` is writable but not executable (so a dropped script can't run).
Combined with the earlier checks (read-only filesystem, dropped
capabilities, PID limits, no Docker socket exposure), this is a reasonably
thorough automated self-check.

**This is not a penetration test, and can't become one by writing more
checks.** A real audit means a person whose actual job is breaking
sandboxes, trying angles neither of us thought to test for. If this project
is ever going to run code from people you don't know and trust, that's
worth paying for before that day — no amount of additional automated
checking here substitutes for it.

### New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BAN_THRESHOLD` | `3` | Rate-limit violations before an IP is temporarily banned |
| `BAN_DURATION_MINUTES` | `15` | How long a ban lasts |
| `SANDBOX_HTTPS` | `false` | Set `true` to also serve HTTPS with a self-signed cert |
| `HTTPS_PORT` | `4443` | Port for the HTTPS listener, when enabled |

## Go support added

- New `docker/go.Dockerfile` (based on `golang:1.22-bookworm`), `go` added
  to the language dropdown and examples library.
- **A real hardening conflict, caught and fixed properly:** `go run`
  compiles to a temp binary and executes it from `/tmp` — but Tier 7 made
  `/tmp` non-executable (`noexec`) specifically to prevent that pattern for
  security. Rather than weaken that globally, Go gets a narrow, explicit
  exception (its own `/tmp` mount without `noexec`) — every other language
  keeps the stricter default.
- Go's build cache is redirected to `/tmp` via `GOCACHE`/`GOPATH` env vars,
  since its default location is under the read-only home directory.
- Not yet pool-eligible (pool is disabled by default anyway — see the
  earlier Tier 7 regression notes).
- `tests/verify-sandbox.js` now includes a Go compile-and-run check.

### Rebuild step required

```
docker build -t sandbox-go -f docker/go.Dockerfile docker/
```

## Go timeout fix

Go's first run was timing out (hitting the 8-second limit) even for a
trivial "hello world" — not a bug, but a real consequence of the isolation
model: every run gets a brand-new, empty container, so Go's build cache
never survives between runs, and every single run has to compile its
standard-library imports from scratch. Go now gets its own 25-second
timeout (`timeoutMs` per-language override in `server/index.js`); every
other language keeps the original 8-second window, since they don't need
more and that window is real protection against runaway/fork-bomb code.
