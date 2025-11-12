# CI Freshness Check

Enforce context file freshness in your CI pipeline using `clarte --check --ci`.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Context is fresh (hash matches, not stale) |
| 1 | Context is stale (hash mismatch, too old, or broken references) |
| 2 | Error (missing config, filesystem error, etc.) |

## Output

In CI mode, output is a single machine-readable line:

- `fresh` - context is up to date
- `stale: hash mismatch` - source files changed since last generation
- `stale: snapshot is 5d old` - timestamp check found age exceeds threshold
- `stale: 3 broken file reference(s)` - context file references non-existent files
- `error: <message>` - something went wrong

## GitHub Actions Example

```yaml
name: Context Freshness
on: [pull_request]

jobs:
  check-context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Check context freshness
        run: npx clarte --check --ci
```

## GitHub Actions with Auto-Fix

```yaml
name: Context Freshness
on: [pull_request]

jobs:
  check-context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Check context freshness
        id: check
        run: npx clarte --check --ci
        continue-on-error: true

      - name: Regenerate if stale
        if: steps.check.outcome == 'failure'
        run: |
          npx clarte --refresh-snapshot
          echo "Context was stale and has been refreshed."
          echo "Please commit the updated context files."
          exit 1
```

## Timestamp-Only Check

For faster checks that skip file hashing:

```yaml
      - name: Check context freshness (timestamp only)
        run: npx clarte --check=timestamp --ci
```

This is faster but only detects staleness by age, not by file changes.
