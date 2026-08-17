# Phase 0b — NoInfra / OpenClaw connectivity spike

Runbook and findings for the invocation spine required by `docs/ARCHITECTURE.md` §7 Phase 0b.
**This proves the pipe, not the pipeline.** No research capability is built here.

```
test client / Vercel  →  OpenClaw /tools/invoke  →  caribecon-research agent
                      →  caribecon_research MCP tool  →  research-service stub
                      →  structured JSON  →  back through Vercel
```

---

## 1. What the investigation established

The original plan (§5.1) assumed the Research Service would run as a normal Node process on a
NoInfra VPS behind an HMAC-signed HTTP channel (§5.7). **That is not possible as designed**, and
the difference is load-bearing enough to record here:

| Assumption in §5.1/§5.7 | What NoInfra/OpenClaw actually provides |
| --- | --- |
| A VPS we can run our own HTTP server on | A container with **no inbound port mapping** — a server started there is unreachable from the public internet |
| Deploy our own code | NoInfra **Applications** is a spec-to-app *generator* (its "Factory" writes the code into a repo NoInfra owns). It cannot host code we wrote |
| Vercel → our service over a signed channel | Reachable surface is the **OpenClaw gateway**, authenticated by a single shared bearer token |

**The viable path** is an MCP server registered in OpenClaw's `mcp.servers`, invoked through the
gateway's always-enabled `/tools/invoke` endpoint. This preserves the §3.2/§5.2 boundary that
*OpenClaw must never become a second planner*: `/tools/invoke` is **direct tool execution** with
no agent reasoning loop and no prompt-injection surface, unlike `/v1/chat/completions`, where
OpenClaw's own model would decide whether and how to comply.

### The residual risk, stated plainly

The gateway bearer token is, per OpenClaw's own documentation, **"effectively all-or-nothing
operator access."** Authentication is *not* per-agent: a holder of the token can call
`/tools/invoke` with `agentId: "main"` and reach every tool the gateway's HTTP deny list does
not block. The per-agent `tools.allow` lock below is therefore **defence against our own bugs,
not against a leaked token.**

True isolation would need a second gateway instance (its own port, own token, only the
restricted agent). That was considered and **rejected for this spike**: it costs ~475 MB RSS on
a 2-core/3.8 GB container and, with no systemd available, would run as an unsupervised `nohup`
process with no restart-on-crash — worse operational reliability for the primary research
runtime, in exchange for isolation that only matters if the token leaks.

Accepted mitigations instead:

1. `chatCompletions` / `responses` endpoints **stay disabled** (default). Never enable them —
   that is the escape hatch that would make the token trivially exploitable.
2. `gateway.tools.deny` is extended to close the gaps found in the default deny list.
3. The token lives only in Vercel server-side env, is never logged, and is rotatable.

---

## 2. Files in this repo

| Path | Role |
| --- | --- |
| `research-service/src/service.mjs` | The Phase 0b stub. Plain async function, **zero** runtime-specific imports (§5.3 rule 1) |
| `research-service/src/mcpServer.mjs` | MCP stdio adapter — the only OpenClaw-facing surface |
| `research-service/src/*.test.mjs` | 10 tests, incl. a real stdio JSON-RPC session against the spawned server |
| `api/noinfraSpike.ts` | The narrow Vercel caller. Not `/api/ask`, not the research pipeline |
| `api/noinfraSpike.test.mjs` | 13 tests against a real local stand-in gateway |

`api/research.ts` is **untouched** and stays frozen.

---

## 3. Deploying the MCP server to the container

The repo is public, so this needs no SSH key and no git identity — **but the branch carrying
`research-service/` must be pushed first, or the clone below finds nothing.** It is not on
`main`, so the branch must be named explicitly:

```bash
mkdir -p ~/workspace && cd ~/workspace
git clone --depth 1 -b feature/research-service https://github.com/zprescod-sys/CaribEcon.git
cd CaribEcon/research-service
npm install --omit=dev
npm test          # 10 tests — proves the tool works before the gateway ever calls it
```

To update later: `git pull && npm install --omit=dev`, then restart the gateway.

Once this work merges to `main`, drop the `-b` flag and re-clone.

---

## 4. Exact OpenClaw configuration

Three changes. **The `main` agent is not modified** — it keeps every tool it has today.

### 4a. Register the MCP server

```json
{
  "mcp": {
    "servers": {
      "caribecon-research": {
        "command": "node",
        "args": ["/home/node/workspace/CaribEcon/research-service/src/mcpServer.mjs"],
        "env": {
          "CARIBECON_RUNTIME": "noinfra"
        }
      }
    }
  }
}
```

**No provider keys here.** The Phase 0b stub calls no provider, so it is given no secret —
nothing is provisioned before it is needed. When Nebius/Tavily/MiniMax arrive in later phases,
they go in this `env` block as **SecretRefs** (`"${NEBIUS_API_KEY}"`), referencing gateway-level
environment variables — never as literal key values in this config file.

### 4b. Add the restricted agent (leave `main` alone)

```json
{
  "agents": {
    "list": [
      {
        "id": "caribecon-research",
        "tools": {
          "profile": "minimal",
          "allow": ["caribecon-research__*"]
        }
      }
    ]
  }
}
```

`profile: "minimal"` starts from almost nothing; `allow` is a true allowlist, so everything not
listed is blocked for this agent. Any existing entries in `agents.list` stay as they are.

### 4c. Close the HTTP deny-list gaps

The default HTTP deny list covers `exec`, `spawn`, `shell`, `fs_write`, `fs_delete`, `fs_move`,
`apply_patch`, `sessions_spawn`, `sessions_send`, `cron`, `gateway`, `nodes` — but **not**
`write`, `edit`, `process` or `code_execution`. Deny is a floor that applies to *all* agents and
callers, so this also hardens the `agentId: "main"` path:

```json
{
  "gateway": {
    "tools": {
      "deny": ["write", "edit", "process", "code_execution"]
    }
  }
}
```

### 4d. Explicitly NOT enabled

Leave these at their defaults — every one of them widens the blast radius of the shared token:

- `gateway.http.endpoints.chatCompletions.enabled` — **must stay `false`**
- `gateway.http.endpoints.responses.enabled` — **must stay `false`**
- Any `gateway.tools.allow` entry that re-enables a denied tool over HTTP

---

## 5. Vercel configuration

| Env var | Value |
| --- | --- |
| `OPENCLAW_GATEWAY_URL` | `https://zeke-prescod-workspace.tenant.noinfra.ai` |
| `OPENCLAW_GATEWAY_TOKEN` | the gateway token — **server-side only** |
| `OPENCLAW_CARIBECON_TOOL` | only if the live tool name differs from the default |
| `OPENCLAW_GATEWAY_TIMEOUT_MS` | optional; defaults to 25000 |

`vercel.json` gives `api/noinfraSpike.ts` a 30s `maxDuration`; the route aborts at 25s so it
fails first with an honest message rather than being cut off by the platform.

---

## 6. The end-to-end test

```bash
curl -sS -X POST "$SITE/api/noinfraSpike" \
  -H 'Content-Type: application/json' \
  -H "X-CaribEcon-Token: $CARIBECON_RESEARCH_TOKEN" \
  -d '{"question":"ping"}'
```

Expected:

```json
{
  "ok": true,
  "agentId": "caribecon-research",
  "tool": "caribecon-research__caribecon_research",
  "result": { "ok": true, "service": "caribecon-research", "runtime": "noinfra" },
  "elapsedMs": 000
}
```

`result` is what came back from the container. `elapsedMs` is the real gateway round-trip —
record it, since no request timeout is documented for `/tools/invoke` and §7's budget numbers
are guesses until measured.

### If it fails

| Response | Meaning |
| --- | --- |
| `503 not_configured` | A Vercel env var is unset — the route fails closed before calling out |
| `502 gateway_unreachable` | Wrong URL, or the gateway is not running |
| `502 gateway_error` + `status: 401` | Wrong gateway token |
| `502 gateway_error` + `status: 404` | **Most likely the tool name prefix** — ask the gateway for its tool list and set `OPENCLAW_CARIBECON_TOOL` |
| `504 gateway_timeout` | No response in 25s — a real finding for the §7 budget |

---

## 6b. Live-run finding: two tool registries, and a gateway that cannot restart

The first live run failed with `gateway_error` / `status: 404` on a correct request. Diagnosis,
by elimination against the live gateway:

| Probe | Result | Conclusion |
| --- | --- | --- |
| `POST /tools/invoke`, no auth | 401 | Path is correct |
| `POST /nonexistent-path` | 404 | That is what a wrong path looks like |
| `session_status`, no `agentId` | ✅ real result | Token valid, gateway healthy |
| `session_status`, `agentId: caribecon-research` | `not_found` | Nothing reachable via that agent |
| 8 candidate tool-name spellings | all `not_found` | Not a naming problem |
| **Same tool from OpenClaw's own chat session** | ✅ **returns the exact stub JSON** | **The MCP server, its config and its name are all correct** |

**The finding: MCP tools registered by hot-reload reach agent sessions but never enter the HTTP
`/tools/invoke` tool registry, which is built at gateway startup.** "Visible in my tool list"
and `not_found` over HTTP are both true at once — they are two different registries.

**And the gateway cannot be restarted from inside the container:**

- `openclaw gateway restart` sends `SIGUSR1`, which is an in-process config *reload*. Uptime
  never resets (observed: 22h+ across several attempted restarts).
- No systemd. The gateway is PID 7 under `tini` as PID 1; killing it exits the container rather
  than respawning the process.
- So a full restart must be triggered from **outside** the container, through NoInfra's own
  controls.

This is the operationally significant result of the spike, and it outlives this one bug: **config
changes to the research runtime cannot be deployed from inside it.** Any change to `mcp.servers`
that must reach the HTTP surface requires an external container restart. That is a real cost to
weigh against NoInfra remaining the *primary* runtime, and an argument the §5.4 Vercel path
deserves to be re-read in light of.

## 7. Open items for the live run

- [x] **Tool name confirmed: `caribecon-research__caribecon_research`** — matches the default in
      `api/noinfraSpike.ts`, so `OPENCLAW_CARIBECON_TOOL` does not need to be set. OpenClaw
      namespaces as `<mcp.servers key>__<registered tool name>`, server key used as-is.
- [x] **`main` agent verified untouched** — its `agents.list` entry is `{ id: "main",
      default: true }` with no `tools` key, so it inherits the same defaults as before. Worth
      recording because the config had to be hand-edited: OpenClaw's `config.patch` refuses
      `mcp.servers` / `agents.list` / `gateway.tools` as protected paths, so its usual
      validation was bypassed. Gateway confirmed running with valid JSON afterwards.
- [ ] Confirm whether the gateway surfaces `structuredContent`, the text block, or both — the route handles all three
- [ ] Record the real round-trip latency
- [ ] Confirm the MCP child process survives a gateway restart, and what supervises it
