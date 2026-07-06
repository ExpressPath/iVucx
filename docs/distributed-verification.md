# Distributed Verification

## Runtime pool

The app can route helper and proof execution requests across multiple helper
workers.

Production env:

```text
HELPER_API_BASE_URLS=http://136.117.215.204:3000
```

`HELPER_API_BASE_URL` remains supported for single-worker deployments. When
`HELPER_API_BASE_URLS` is set, the single URL is not appended to the active
pool.

For burst verification, start the two stopped workers and temporarily set the
pool to:

```text
HELPER_API_BASE_URLS=http://34.19.92.107:3000,http://136.117.232.34:3000,http://136.117.215.204:3000
```

Local helper commands:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\gce-helper-workers-start.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\gce-helper-workers-stop.ps1
```

## Automatic burst scaling

Production is configured for automatic burst scaling:

- Always-on worker: `instance-20260503-231452`
- Standby workers: `ivucx-helper-worker-1`, `ivucx-helper-worker-2`
- Scaler: Cloud Run service `ivucx-helper-scaler`
- Stop reconciler: Cloud Scheduler job `ivucx-helper-scaler-reconcile`

Vercel triggers scale-out when a proof execution request is heavy enough:

```text
HELPER_AUTOSCALE_ENABLED=true
HELPER_AUTOSCALE_CODE_BYTES=10000
HELPER_AUTOSCALE_INFLIGHT=2
HELPER_AUTOSCALE_WARMUP_MS=90000
HELPER_AUTOSCALE_ACTIVE_MS=600000
HELPER_STANDBY_BASE_URLS=http://34.19.92.107:3000,http://136.117.232.34:3000
```

The first heavy request still runs on the always-on worker. The standby workers
are started in the background, and after the warmup window they become eligible
for the Vercel worker pool in that function process.

The scaler records activity in GCE instance metadata. The scheduler calls
`/reconcile` every 10 minutes. If standby workers have been idle longer than the
configured idle window, it stops them. Keep the Vercel burst-active window
shorter than the scaler idle-stop window so Vercel does not keep routing to
workers after the scheduler has stopped them.

Stopped VMs do not incur CPU and memory charges, but attached disks, retained
IP addresses, and other attached resources can still be billed. Delete unused
burst workers and release their static IPs when they are no longer needed.

The scheduler keeps per-worker runtime state in the Vercel function process:

- `inflight`
- EWMA `lastLatencyMs`
- consecutive failure count
- short circuit-breaker window after 502/503/504 or network failure

Each request is sent to the available worker with the lowest score:

```text
score = inflight * 1000 + lastLatencyMs + consecutiveFailures * 5000
```

Retries are limited to safe requests: GET/HEAD and pure Lean/Coq check routes.
Heavy helper submit/convert POSTs are assigned to a worker but are not blindly
replayed, because a timeout after job creation could duplicate work.

## Large task splitting design

Do not split arbitrary Lean/Coq text by size alone. Proof files have imports,
sections, notation, local instances, and theorem dependencies. Unsafe splitting
can produce false failures.

Recommended algorithm:

1. Parse the submitted project/file into declarations or modules.
2. Build a dependency graph from imports and symbol references.
3. Hash each node by content plus dependency hashes.
4. Reuse cached successful nodes by hash.
5. Put ready nodes whose dependencies are complete into a shared job table.
6. Let workers claim jobs with a lease:

```text
id
input_hash
language
status
priority
dependencies
lease_owner
lease_expires_at
attempts
created_at
updated_at
result_json
```

7. Dispatch ready jobs to idle workers using the current pool score.
8. If dependency analysis is uncertain, fall back to monolithic verification.

For the current deployment, the implemented safe step is worker-pool scheduling
and failover. True intra-proof splitting should be added only after parser-based
dependency extraction exists for the target language.
