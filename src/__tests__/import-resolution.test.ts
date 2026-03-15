import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadTsconfigPaths } from "../core/graph/import-resolution.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "clarte-tsconfig-"));
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("loadTsconfigPaths", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("loads simple path aliases", async () => {
    tmpDir = await makeTmpDir();
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );

    const aliases = await loadTsconfigPaths(tmpDir);

    expect(aliases).toHaveLength(1);
    expect(aliases[0].prefix).toBe("@/");
    expect(aliases[0].replacement).toBe("src/");
  });

  it("resolves baseUrl relative to config file directory", async () => {
    tmpDir = await makeTmpDir();

    // Create a base config in a subdirectory
    const configDir = path.join(tmpDir, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "..",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );

    // Root tsconfig extends the base config
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./config/base.json",
      }),
    );

    const aliases = await loadTsconfigPaths(tmpDir);

    expect(aliases).toHaveLength(1);
    // baseUrl ".." from config/base.json resolves to tmpDir (parent of config/)
    // which is "." relative to rootDir
    expect(aliases[0].replacement).toBe("src/");
  });

  it("resolves baseUrl in nested config (monorepo scenario)", async () => {
    tmpDir = await makeTmpDir();

    // Shared config with baseUrl pointing to itself
    const sharedDir = path.join(tmpDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "~/*": ["lib/*"] },
        },
      }),
    );

    // Package tsconfig extends shared config
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./shared/tsconfig.base.json",
      }),
    );

    const aliases = await loadTsconfigPaths(tmpDir);

    expect(aliases).toHaveLength(1);
    // baseUrl "." from shared/tsconfig.base.json resolves to shared/
    // So the replacement should be "shared/lib/"
    expect(aliases[0].replacement).toBe("shared/lib/");
  });

  it("child config baseUrl overrides parent baseUrl", async () => {
    tmpDir = await makeTmpDir();

    await fs.writeFile(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "lib",
          paths: { "@/*": ["mod/*"] },
        },
      }),
    );

    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          baseUrl: "src",
        },
      }),
    );

    const aliases = await loadTsconfigPaths(tmpDir);

    expect(aliases).toHaveLength(1);
    // Child's baseUrl "src" (from root tsconfig.json) wins
    expect(aliases[0].replacement).toBe("src/mod/");
  });

  it("returns empty array when no tsconfig exists", async () => {
    tmpDir = await makeTmpDir();
    const aliases = await loadTsconfigPaths(tmpDir);
    expect(aliases).toEqual([]);
  });
});
