# R12: Prompt Enrichment Cost/Latency Model

## System Overview

A `UserPromptSubmit` hook calls Haiku to localize relevant files before the main agent starts. The hook reads a codebase summary from disk, sends it with the user prompt to Haiku, and returns file-level context as `additionalContext`.

## 1. Token Budget

### Pricing math

Haiku: $0.25/MTok input, $1.25/MTok output.

Target: enrichment < 5% of minimum session cost ($0.40), so **$0.02 per call**.

Output is small (file paths + short context lines). Assume 200-400 output tokens per call (~$0.0003-0.0005). Output cost is negligible. The constraint is input tokens.

**Maximum input tokens at $0.02 budget:**
- $0.02 / ($0.25 / 1M) = **80,000 input tokens** (no caching)
- With prompt caching (90% off cached prefix): effectively **800,000 cached + dynamic suffix**

So without caching, 80K tokens is the hard ceiling. With caching, the ceiling is essentially unlimited for the static prefix.

### Codebase size scaling (context-map.json format)

Measured from clarte's own repo (130 significant files out of ~180 total):

| Metric | Value |
|--------|-------|
| Entries in context-map | 130 |
| Total chars (keys + values) | 31,380 |
| Estimated tokens | ~7,800 |
| Avg chars per entry | 241 |
| Avg tokens per entry | ~60 |

Projected scaling for context-map format (significant files only, ~60-70% of total):

| Project files | Significant entries (est.) | Tokens (context-map) | Cost (no cache) | Cost (cached) |
|---------------|---------------------------|----------------------|-----------------|---------------|
| 100 | 65 | ~3,900 | $0.0010 | $0.0001 |
| 500 | 325 | ~19,500 | $0.0049 | $0.0005 |
| 1,000 | 650 | ~39,000 | $0.0098 | $0.0010 |
| 5,000 | 3,250 | ~195,000 | $0.0488 | $0.0049 |

System prompt + task instructions add ~500 tokens. User prompt adds ~50-200 tokens.

**Breakeven without caching**: ~3,200 significant files (~5,000 total files) hits the $0.02 ceiling.
**Breakeven with caching**: essentially unlimited; even 5,000 files costs $0.005.

### Recommendation

Use prompt caching. The context-map is static between `clarte` regenerations (days/weeks). It is the perfect candidate for a cached prefix. With caching, even monorepos are well within budget.

## 2. Codebase Summary Compression

### Current format works well

The existing `context-map.json` is already compact: ~60 tokens per significant file, only files above the betweenness/chokepoint/cochange threshold get entries. For a 500-file project, that is ~19K tokens, which fits comfortably in the $0.02 budget even without caching.

### For 5,000+ file monorepos: tiered compression

When the context-map exceeds 40K tokens (roughly 700 significant files / 1,000 total), apply compression tiers:

**Tier 1: Package-level summaries (for monorepos)**

Instead of listing all files in all packages, send:
- Full file-level entries for the top N packages by centrality
- Package-level summaries for the rest: `packages/auth: 47 files, key exports: AuthService, JwtStrategy, AuthGuard`
- Let Haiku decide which packages are relevant, then the enrichment response says "look in packages/auth and packages/users"

Token cost per package summary: ~20-30 tokens vs ~60 tokens per file.
A 5,000-file monorepo with 15 packages: 3 packages fully expanded (~650 entries, ~39K tokens) + 12 packages summarized (~360 tokens) = ~39.4K tokens. Under budget.

**Tier 2: Directory tree with counts**

For extreme cases (10,000+ files):
```
src/
  auth/ (47 files) - AuthService, JwtStrategy
  users/ (32 files) - UserRepository, CreateUserDto
  orders/ (89 files) - OrderService, PaymentGateway
```
~10-15 tokens per directory. A 10,000-file project with 200 directories: ~2,500 tokens.

**Tier 3: Pre-filter by keyword match**

Before calling Haiku, do a cheap string match: tokenize the user prompt, match against file paths and export names in the context-map. Send only the matching subtree + its neighborhood (imports/dependents).

This is a hybrid of the "free enrichment" option (section 7) and the LLM call. It narrows the input from 195K tokens to maybe 5-10K tokens.

### Recommended strategy

```
if contextMapTokens <= 40_000:
  send full context-map as cached prefix
elif project.isMonorepo:
  send package summaries + expand top 3 packages
else:
  pre-filter by keyword match, send top 200 entries
```

## 3. Prompt Caching

### How it works

Anthropic prompt caching: the first request with a new prefix pays full price and caches it. Subsequent requests with the same prefix get 90% discount on the cached portion. Cache TTL is 5 minutes (extended on each hit).

### Application to enrichment

The prompt structure:

```
[SYSTEM: task instructions + output format]  -- ~500 tokens, static
[CONTEXT: context-map.json]                   -- 4K-40K tokens, static between clarte runs
---cache boundary---
[USER: the user's prompt]                     -- 50-200 tokens, dynamic
```

### Cost with caching

| Project files | Context tokens | First call (cold) | Subsequent calls (warm) |
|---------------|---------------|-------------------|------------------------|
| 100 | 4,400 | $0.0011 | $0.00016 |
| 500 | 20,000 | $0.0050 | $0.00055 |
| 1,000 | 39,500 | $0.0099 | $0.00104 |
| 5,000 | 40,000 (compressed) | $0.0100 | $0.00105 |

**Per-session cost** (assuming 1 cold + 2 warm calls per session):

| Project files | Session enrichment cost | % of $0.40 min session | % of $2.00 avg session |
|---------------|------------------------|------------------------|------------------------|
| 100 | $0.0014 | 0.4% | 0.07% |
| 500 | $0.0061 | 1.5% | 0.3% |
| 1,000 | $0.0120 | 3.0% | 0.6% |
| 5,000 | $0.0121 | 3.0% | 0.6% |

All cases are under $0.02 per session. The 5,000-file case costs the same as 1,000 because compression caps the context at ~40K tokens.

### Cache warming

The `SessionStart` hook already exists. It currently gates on model (disables hooks for Haiku). Extend it to:

1. Make a no-op Haiku call with the context-map prefix to warm the cache
2. The first `UserPromptSubmit` call then gets the cached rate

Cost of cache warming: one cold call ($0.005-0.01) amortized across 1-3 enrichment calls per session. Net savings: ~$0.003-0.008 per session on the warm calls.

**Verdict**: Cache warming is worth it only if the session will have 2+ enrichment calls. For single-prompt sessions (estimated 40-50% of sessions), it wastes the warming cost. Skip it. Let the first enrichment call pay cold price; subsequent calls benefit automatically.

## 4. Latency Optimization

### Latency budget breakdown

Target: < 2 seconds end-to-end (user submits prompt to main agent streaming).

| Step | Duration | Notes |
|------|----------|-------|
| Node.js startup | 30-50ms | ESM module, no heavy deps |
| Read stdin (JSON parse) | < 5ms | Small payload |
| Read context-map.json from disk | 5-10ms | 32KB file, warm FS cache |
| Build Haiku prompt | < 5ms | String concatenation |
| Haiku API call | 200-800ms | Depends on input size and output length |
| Parse Haiku response | < 5ms | Small JSON |
| Write stdout | < 5ms | Small payload |
| **Total** | **250-880ms** | |

### Haiku latency by input size

Based on typical Haiku response times (TTFT + generation):

| Input tokens | TTFT (est.) | Output (200 tokens) | Total |
|-------------|-------------|---------------------|-------|
| 5,000 | 100-200ms | 100-200ms | 200-400ms |
| 20,000 | 200-400ms | 100-200ms | 300-600ms |
| 40,000 | 300-600ms | 100-200ms | 400-800ms |

With prompt caching, TTFT drops by ~50% on warm requests because the cached prefix is pre-processed.

### Optimization: stream and return early

Haiku's output will be structured: file paths first, then optional reasoning. We can:

1. Stream the response
2. Parse partial JSON as it arrives
3. Return as soon as we have the file list (before any explanation text)

Estimated savings: 50-100ms (cuts tail of generation). Worth implementing but not critical.

### Optimization: parallel with main agent startup

If Claude Code's hook architecture allows it, the enrichment hook could run while the main agent's system prompt is being assembled. This would hide the latency entirely. However, `UserPromptSubmit` hooks are synchronous and blocking by design, so this is not possible with the current hook model.

### Realistic end-to-end latency

| Scenario | Latency |
|----------|---------|
| Small project (100 files), warm cache | ~300ms |
| Medium project (500 files), warm cache | ~450ms |
| Large project (1,000 files), warm cache | ~550ms |
| Monorepo (5,000 files), compressed, warm cache | ~600ms |
| Any project, cold cache | add ~100-200ms |

**All scenarios are under 1 second.** Well within the 2-second budget.

### Timeout

Set a hard 3-second timeout on the Haiku call. If it exceeds this, return empty (no enrichment). The main agent proceeds without enrichment; the user never waits more than 3 seconds.

## 5. Tiered Approach: When to Skip Enrichment

### The R8 finding

Clarte helps on monorepos (-29% turns on NestJS), hurts on single-package projects (+24% turns on TypeORM). The enrichment hook inherits this dynamic: context injection is valuable when the agent needs help navigating across packages, harmful (or neutral at best) when the project is flat.

### Decision matrix

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Single package, < 200 files | Skip enrichment entirely | Agent navigates fine by directory structure. R6/R8 show no benefit. |
| Single package, 200-500 files | Heuristic-only enrichment (section 7) | Zero cost, zero latency. May help on larger single-package projects. |
| Monorepo, any size | Full Haiku enrichment | R8: -29% turns. Navigation across packages is where the agent struggles. |
| Single package, 500+ files | Full Haiku enrichment | Untested but likely beneficial; large flat projects have navigation cost. |

### Detection

The monorepo/single-package distinction is already computed by clarte during graph generation. Store a `packageCount` field in context-map.json metadata:

```json
{
  "_meta": { "packageCount": 9, "totalFiles": 1228, "generatedAt": "..." },
  "src/utils.ts": "role: Foundation | betweenness: 4% ..."
}
```

The hook script reads `_meta.packageCount` and decides:
- `packageCount > 1` or `totalFiles > 500`: call Haiku
- Otherwise: skip (or use heuristic fallback)

### Cost of the gate check

Reading `_meta` from the already-loaded JSON: < 1ms. Free.

## 6. Rate Limiting and Circuit Breakers

### Per-session limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max enrichment calls per session | 5 | Sessions rarely have > 5 user prompts. Prevents runaway cost. |
| Per-call timeout | 3,000ms | User patience threshold. |
| Per-session cost cap | $0.05 | Hard ceiling. Even 5 calls at cold cache rates on a monorepo. |

### Implementation

Store a counter in a temp file (`/tmp/clarte-enrich-{session-id}.count`). Increment on each call. Skip enrichment when limit is reached.

The `SessionStart` hook already writes to `CLAUDE_ENV_FILE`. Use the same mechanism:
```
export CLARTE_ENRICH_COUNT=0
export CLARTE_ENRICH_SESSION_ID=<random>
```

Each `UserPromptSubmit` call increments the counter. On exceeding the limit, skip silently.

### Failure handling

| Failure mode | Response |
|-------------|----------|
| Haiku API timeout (> 3s) | Return empty JSON, proceed without enrichment |
| Haiku API error (4xx/5xx) | Return empty JSON, log to stderr |
| Haiku returns malformed JSON | Return empty JSON, log to stderr |
| context-map.json missing | Return empty JSON (clarte not configured) |
| context-map.json corrupt | Return empty JSON, log to stderr |
| ANTHROPIC_API_KEY missing | Return empty JSON (user hasn't configured API access) |

**Principle: never block the main agent.** Every failure mode falls through to "no enrichment." The user's session continues normally.

### Circuit breaker

After 2 consecutive failures in a session, disable enrichment for the rest of the session (set `CLARTE_ENRICH_DISABLED=1` in env). Reset on next session.

## 7. The "Free Enrichment" Option: Heuristic Matching

### How it works

No API call. Pure string matching:

1. Tokenize user prompt (split on whitespace, remove stop words)
2. Match tokens against file paths and export names in context-map
3. Score each file by number of token matches
4. Return top 5-10 files as additionalContext

### Cost and latency

- API cost: $0.00
- Latency: ~10-20ms (string matching on in-memory JSON)
- Accuracy: depends on prompt specificity

### When heuristic matching works

Good:
- "Fix the JWT verification in verifyFromJwks" - matches `src/auth/jwt/verify-from-jwks.ts` directly
- "The OrderService throws when quantity is 0" - matches `src/services/order-service.ts`
- "Update the WebSocket adapter shutdown" - matches `src/adapters/ws-adapter.ts`

Bad:
- "Users can't log in" - matches nothing specific (symptom description, not code reference)
- "The CI pipeline fails on the auth tests" - matches too broadly
- "Performance regression in the API" - no file-level signal

### Accuracy estimate

From R6/R8 benchmark prompts:
- **Opaque prompts** (symptom-only): heuristic would find the right file ~20-30% of the time
- **Detailed prompts** (names functions/files): heuristic would find the right file ~70-80% of the time

For detailed prompts, heuristic matching is nearly as good as an LLM call. For opaque prompts, it is significantly worse.

### Hybrid approach

Use heuristic matching as the fast path:
1. Run heuristic match (10ms)
2. If match confidence is high (3+ token matches on a single file), return immediately
3. If match confidence is low (0-1 matches), fall through to Haiku call

This gets the best of both worlds: zero-cost on easy cases, LLM backup on hard cases. Expected distribution: ~40% of prompts resolved by heuristic (detailed prompts with file/function names), ~60% fall through to Haiku.

**Cost savings**: 40% of calls are free, 60% pay Haiku rate. Per-session cost drops from ~$0.006 to ~$0.004.

### Implementation sketch

```typescript
function heuristicMatch(prompt: string, contextMap: Record<string, string>): string[] | null {
  const tokens = tokenize(prompt); // split, lowercase, remove stop words
  const scores = new Map<string, number>();

  for (const [path, context] of Object.entries(contextMap)) {
    let score = 0;
    const searchable = (path + " " + context).toLowerCase();
    for (const token of tokens) {
      if (searchable.includes(token)) score++;
    }
    if (score > 0) scores.set(path, score);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] < 2) return null; // low confidence
  return ranked.slice(0, 10).map(([path]) => path);
}
```

## 8. Cost Tracking

### What to track

| Metric | Storage | Purpose |
|--------|---------|---------|
| Enrichment calls per session | Temp file | Rate limiting |
| Input tokens per call | Log file | Cost analysis |
| Output tokens per call | Log file | Cost analysis |
| Latency per call (ms) | Log file | Performance monitoring |
| Cache hit (warm/cold) | Log file | Cache effectiveness |
| Heuristic fallback used | Log file | Hybrid accuracy tracking |

### Log location

`~/.clarte/enrichment.log` (append-only, one JSON line per call):

```json
{"ts":"2026-03-07T10:15:32Z","session":"abc123","inputTok":20100,"outputTok":187,"latencyMs":412,"cached":true,"heuristic":false,"cost":0.00055}
```

### User visibility

- `clarte stats` command: show aggregate enrichment cost over last 30 days
- Per-session: print nothing. The enrichment should be invisible.
- On `--verbose`: print enrichment latency and cost per call to stderr

### Privacy

The log stores token counts and latency, not prompt content or file paths. No PII, no code content.

## Summary: Target Architecture

```
UserPromptSubmit hook fires
  |
  +--> Read context-map.json from .clarte/hooks/ (<10ms)
  |
  +--> Check _meta.packageCount and totalFiles
  |      |
  |      +--> < 200 files, single package: SKIP (return empty)
  |      |
  |      +--> 200-500 files, single package: heuristic match only
  |      |
  |      +--> monorepo or 500+ files: continue to LLM
  |
  +--> Heuristic match against prompt tokens (10ms)
  |      |
  |      +--> High confidence (2+ matches): RETURN file context
  |      |
  |      +--> Low confidence: continue to Haiku
  |
  +--> Check rate limit (< 5 calls/session)
  |
  +--> Call Haiku with cached prefix (300-800ms)
  |      |
  |      +--> Timeout after 3s: return empty
  |      +--> Error: return empty, log
  |      +--> Success: parse response, return file context
  |
  +--> Log metrics to ~/.clarte/enrichment.log
  |
  +--> Return { additionalContext: "..." } to stdout
```

### Cost per session (expected)

| Project type | Enrichment cost | % of session cost |
|-------------|----------------|-------------------|
| Small single-package (< 200 files) | $0.000 | 0% |
| Medium single-package (200-500 files) | $0.000-0.002 | 0-0.5% |
| Large single-package (500+ files) | $0.003-0.006 | 0.2-1.5% |
| Monorepo (any size) | $0.004-0.012 | 0.2-3.0% |

### Latency (expected)

| Scenario | Latency |
|----------|---------|
| Skipped (small project) | 15ms |
| Heuristic match (no API call) | 20ms |
| Haiku call, warm cache | 300-600ms |
| Haiku call, cold cache | 400-800ms |
| Haiku timeout | 3,000ms (hard cap) |

Both targets met: **< $0.01 per session, < 1 second typical latency**.
