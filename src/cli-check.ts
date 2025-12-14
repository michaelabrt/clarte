import { loadConfig, computeSnapshotHash } from "./config/config.js";
import { validateContextPaths } from "./check.js";

/**
 * Handle --check mode: fast path for shell integration.
 * Exit codes: 0=fresh, 1=stale, 2=error/missing.
 */
export async function runCheckMode(rootDir: string, checkTimestamp: boolean, ciMode: boolean): Promise<never> {
  try {
    const config = await loadConfig(rootDir);

    if (checkTimestamp) {
      if (!config) {
        if (ciMode) {
          console.log("none");
        } else {
          console.log("clarte: no context file found. Run npx clarte to generate.");
        }
        process.exit(2);
      }
      if (!config.snapshotGeneratedAt) {
        if (ciMode) console.log("fresh");
        process.exit(0);
      }
      const staleDays = config.staleDays ?? 7;
      const daysSince = Math.floor((Date.now() - config.snapshotGeneratedAt) / (1000 * 60 * 60 * 24));
      if (daysSince > staleDays) {
        if (ciMode) {
          console.log(`stale: snapshot is ${daysSince}d old`);
        } else {
          console.log(`clarte: snapshot is ${daysSince}d old. Run: npx clarte --refresh-snapshot`);
        }
        process.exit(1);
      }
      if (config) {
        const pathResult = await validateContextPaths(rootDir, config);
        if (pathResult && pathResult.broken.length > 0) {
          if (ciMode) {
            console.log(`stale: ${pathResult.broken.length} broken file reference(s)`);
          } else {
            console.log(
              `clarte: ${pathResult.broken.length} broken file reference(s) in ${pathResult.file}: ${pathResult.broken.join(", ")}`,
            );
          }
          process.exit(1);
        }
      }
      if (ciMode) console.log("fresh");
      process.exit(0);
    }

    // Hash-based check (original behavior)
    if (!config) {
      if (ciMode) {
        console.log("none");
      } else {
        console.log("clarte: no context file found. Run npx clarte to generate.");
      }
      process.exit(2);
    }
    if (!config.snapshotHash) {
      if (ciMode) console.log("fresh");
      process.exit(0);
    }
    const lang = config.language ?? "other";
    const currentHash = await computeSnapshotHash(rootDir, lang);
    if (currentHash !== config.snapshotHash) {
      const daysSince = config.snapshotGeneratedAt
        ? Math.floor((Date.now() - config.snapshotGeneratedAt) / (1000 * 60 * 60 * 24))
        : 0;
      const staleMsg = daysSince > 0 ? ` (last generated ${daysSince}d ago)` : "";
      if (ciMode) {
        console.log(`stale: hash mismatch${staleMsg}`);
      } else {
        console.log(`clarte: snapshot is stale${staleMsg}. Run npx clarte --refresh-snapshot`);
      }
      process.exit(1);
    }

    const pathResult = await validateContextPaths(rootDir, config);
    if (pathResult && pathResult.broken.length > 0) {
      if (ciMode) {
        console.log(`stale: ${pathResult.broken.length} broken file reference(s)`);
      } else {
        console.log(
          `clarte: ${pathResult.broken.length} broken file reference(s) in ${pathResult.file}: ${pathResult.broken.join(", ")}`,
        );
      }
      process.exit(1);
    }
    if (ciMode) console.log("fresh");
    process.exit(0);
  } catch (err: unknown) {
    if (ciMode) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    throw err;
  }
}
