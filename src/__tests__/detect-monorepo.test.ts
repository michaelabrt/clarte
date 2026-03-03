import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { detectMonorepo } from "../detect/monorepo.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-monorepo-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("detectMonorepo", () => {
  it("detects pnpm-workspace.yaml as pnpm-workspaces", async () => {
    // Create pnpm-workspace.yaml
    await fs.writeFile(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    // Create a package
    const pkgDir = path.join(tmpDir, "packages", "core");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@test/core", dependencies: {} }));

    const result = await detectMonorepo(tmpDir, ["pnpm-workspace.yaml", "packages"]);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("pnpm-workspaces");
    expect(result?.packages).toHaveLength(1);
    expect(result?.packages[0].name).toBe("@test/core");
  });

  it("detects package.json workspaces as npm-workspaces", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    const pkgDir = path.join(tmpDir, "packages", "ui");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@test/ui", dependencies: { react: "^18.0.0" } }),
    );

    const result = await detectMonorepo(tmpDir, ["package.json", "packages"]);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("npm-workspaces");
    expect(result?.packages).toHaveLength(1);
    expect(result?.packages[0].name).toBe("@test/ui");
  });

  it("detects turborepo.json as turborepo", async () => {
    await fs.writeFile(path.join(tmpDir, "turbo.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    const appDir = path.join(tmpDir, "apps", "web");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "@test/web", dependencies: {} }));

    const result = await detectMonorepo(tmpDir, ["turbo.json", "pnpm-workspace.yaml", "apps"]);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("turborepo");
  });

  it("returns null when no monorepo markers are found", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "single-package" }));

    const result = await detectMonorepo(tmpDir, ["package.json"]);

    expect(result).toBeNull();
  });

  it("detects frameworks in package dependencies", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    const pkgDir = path.join(tmpDir, "packages", "app");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@test/app",
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
      }),
    );

    const result = await detectMonorepo(tmpDir, ["package.json", "packages"]);

    expect(result).not.toBeNull();
    const pkg = result?.packages[0];
    expect(pkg.frameworks.length).toBeGreaterThan(0);
    expect(pkg.frameworks.some((f) => f.name === "Next.js" || f.name === "React")).toBe(true);
  });
});
