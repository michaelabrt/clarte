import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { loadConfig, saveConfig, configToAnswers, computeSnapshotHash } from "../config.js";
import type { ProjectConfig, UserAnswers } from "../types.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "clarte-cfg-"));
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeConfig(dir: string, obj: Record<string, unknown>) {
  await fs.writeFile(
    path.join(dir, ".clarte.json"),
    JSON.stringify(obj, null, 2),
    "utf-8",
  );
}

const sampleAnswers: UserAnswers = {
  ides: ["claude", "cursor"],
  projectPurpose: "A CLI tool for AI context",
  keyPatterns: "Conventional commits",
  gotchas: "Don't use default exports",
  generateSnapshot: true,
  snapshotPaths: ["src/"],
  stackConfirmed: true,
  stackCorrections: "",
  generatePerPackage: false,
};

// ── loadConfig ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("returns null when no config file exists", async () => {
    tmpDir = await makeTmpDir();
    const config = await loadConfig(tmpDir);
    expect(config).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, { keyPatterns: "foo" });
    const config = await loadConfig(tmpDir);
    expect(config).toBeNull();
  });

  it("loads a valid config", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ides: ["claude", "cursor"],
      projectPurpose: "Test project",
      keyPatterns: "patterns",
      gotchas: "gotchas",
      generateSnapshot: true,
      snapshotPaths: ["src/"],
      stackCorrections: "",
      generatePerPackage: false,
    });

    const config = await loadConfig(tmpDir);

    expect(config).not.toBeNull();
    expect(config!.ides).toEqual(["claude", "cursor"]);
    expect(config!.projectPurpose).toBe("Test project");
    expect(config!.generateSnapshot).toBe(true);
  });

  it("migrates old single ide field to ides array", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ide: "cursor",
      projectPurpose: "Legacy project",
    });

    const config = await loadConfig(tmpDir);

    expect(config).not.toBeNull();
    expect(config!.ides).toEqual(["cursor"]);
  });

  it("prefers ides array over old ide field", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ide: "cursor",
      ides: ["claude", "copilot"],
      projectPurpose: "Project with both fields",
    });

    const config = await loadConfig(tmpDir);

    expect(config!.ides).toEqual(["claude", "copilot"]);
  });

  it("fills in defaults for missing optional fields", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ides: ["claude"],
      projectPurpose: "Minimal config",
    });

    const config = await loadConfig(tmpDir);

    expect(config!.keyPatterns).toBe("");
    expect(config!.gotchas).toBe("");
    expect(config!.generateSnapshot).toBe(false);
    expect(config!.snapshotPaths).toEqual([]);
    expect(config!.stackCorrections).toBe("");
    expect(config!.generatePerPackage).toBe(false);
  });
});

// ── saveConfig + loadConfig round-trip ──────────────────────────────────────

describe("saveConfig + loadConfig round-trip", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("round-trips all user answers", async () => {
    tmpDir = await makeTmpDir();

    await saveConfig(tmpDir, sampleAnswers, "deadbeef12345678", "typescript");
    const loaded = await loadConfig(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.ides).toEqual(sampleAnswers.ides);
    expect(loaded!.projectPurpose).toBe(sampleAnswers.projectPurpose);
    expect(loaded!.keyPatterns).toBe(sampleAnswers.keyPatterns);
    expect(loaded!.gotchas).toBe(sampleAnswers.gotchas);
    expect(loaded!.generateSnapshot).toBe(sampleAnswers.generateSnapshot);
    expect(loaded!.snapshotHash).toBe("deadbeef12345678");
    expect(loaded!.language).toBe("typescript");
  });

  it("preserves existing staleDays on re-save", async () => {
    tmpDir = await makeTmpDir();

    await writeConfig(tmpDir, {
      _version: 1,
      ides: ["claude"],
      projectPurpose: "Test",
      staleDays: 30,
    });

    await saveConfig(tmpDir, sampleAnswers);
    const loaded = await loadConfig(tmpDir);

    expect(loaded!.staleDays).toBe(30);
  });
});

// ── configToAnswers ─────────────────────────────────────────────────────────

describe("configToAnswers", () => {
  it("converts config to answers with stackConfirmed=true", () => {
    const config: ProjectConfig = {
      ides: ["claude"],
      projectPurpose: "Test",
      keyPatterns: "patterns",
      gotchas: "gotchas",
      generateSnapshot: true,
      snapshotPaths: ["src/"],
      stackCorrections: "corrected",
      generatePerPackage: false,
    };

    const answers = configToAnswers(config);

    expect(answers.ides).toEqual(["claude"]);
    expect(answers.stackConfirmed).toBe(true);
    expect(answers.stackCorrections).toBe("corrected");
  });
});

// ── computeSnapshotHash ─────────────────────────────────────────────────────

describe("computeSnapshotHash", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("returns a 16-char hex string", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), "export const x = 1;");

    const hash = await computeSnapshotHash(tmpDir, "typescript");

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a file is modified", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), "export const x = 1;");

    const hash1 = await computeSnapshotHash(tmpDir, "typescript");

    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), "export const x = 2;");

    const hash2 = await computeSnapshotHash(tmpDir, "typescript");

    expect(hash1).not.toBe(hash2);
  });
});
