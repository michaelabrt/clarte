import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { loadConfig, saveConfig, configToAnswers, computeSnapshotHash, migrateConfig } from "../core/config/config.js";
import type { ProjectConfig, UserAnswers } from "../core/types.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "clarte-cfg-"));
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeConfig(dir: string, obj: Record<string, unknown>) {
  await fs.writeFile(path.join(dir, ".clarte.json"), JSON.stringify(obj, null, 2), "utf-8");
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
    expect(config?.ides).toEqual(["claude", "cursor"]);
    expect(config?.projectPurpose).toBe("Test project");
    expect(config?.generateSnapshot).toBe(true);
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
    expect(config?.ides).toEqual(["cursor"]);
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

    expect(config?.ides).toEqual(["claude", "copilot"]);
  });

  it("fills in defaults for missing optional fields", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ides: ["claude"],
      projectPurpose: "Minimal config",
    });

    const config = await loadConfig(tmpDir);

    expect(config?.keyPatterns).toBe("");
    expect(config?.gotchas).toBe("");
    expect(config?.generateSnapshot).toBe(false);
    expect(config?.snapshotPaths).toEqual([]);
    expect(config?.stackCorrections).toBe("");
    expect(config?.generatePerPackage).toBe(false);
  });

  it("loads delivery config", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 2,
      ides: ["claude"],
      projectPurpose: "Test",
      delivery: { scopedRules: true, enrichedHooks: false, onDemandSkills: true },
    });

    const config = await loadConfig(tmpDir);

    expect(config?.delivery).toEqual({ scopedRules: true, enrichedHooks: false, onDemandSkills: true });
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
    expect(loaded?.ides).toEqual(sampleAnswers.ides);
    expect(loaded?.projectPurpose).toBe(sampleAnswers.projectPurpose);
    expect(loaded?.keyPatterns).toBe(sampleAnswers.keyPatterns);
    expect(loaded?.gotchas).toBe(sampleAnswers.gotchas);
    expect(loaded?.generateSnapshot).toBe(sampleAnswers.generateSnapshot);
    expect(loaded?.snapshotHash).toBe("deadbeef12345678");
    expect(loaded?.language).toBe("typescript");
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

    expect(loaded?.staleDays).toBe(30);
  });

  it("preserves existing delivery config on re-save", async () => {
    tmpDir = await makeTmpDir();

    await writeConfig(tmpDir, {
      _version: 2,
      ides: ["claude"],
      projectPurpose: "Test",
      delivery: { scopedRules: true, onDemandSkills: true },
    });

    await saveConfig(tmpDir, sampleAnswers);
    const loaded = await loadConfig(tmpDir);

    expect(loaded?.delivery).toEqual({ scopedRules: true, onDemandSkills: true });
  });
});

// ── layers config ───────────────────────────────────────────────────────────

describe("layers config", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("round-trips layers through save and load", async () => {
    tmpDir = await makeTmpDir();
    const answersWithLayers: UserAnswers = {
      ...sampleAnswers,
      layers: [
        { name: "domain", pattern: "(?:^|/)domain/" },
        { name: "infra", pattern: "(?:^|/)infra/" },
      ],
    };

    await saveConfig(tmpDir, answersWithLayers);
    const loaded = await loadConfig(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.layers).toEqual([
      { name: "domain", pattern: "(?:^|/)domain/" },
      { name: "infra", pattern: "(?:^|/)infra/" },
    ]);
  });

  it("omits layers from config when not provided", async () => {
    tmpDir = await makeTmpDir();

    await saveConfig(tmpDir, sampleAnswers);
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, ".clarte.json"), "utf-8"));

    expect(raw.layers).toBeUndefined();
  });

  it("loads config without layers field (backward compat)", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ides: ["claude"],
      projectPurpose: "No layers",
    });

    const loaded = await loadConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.layers).toBeUndefined();
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

  it("maps layers field from config to answers", () => {
    const config: ProjectConfig = {
      ides: ["claude"],
      projectPurpose: "Test",
      keyPatterns: "",
      gotchas: "",
      generateSnapshot: false,
      snapshotPaths: [],
      stackCorrections: "",
      generatePerPackage: false,
      layers: [{ name: "domain", pattern: "(?:^|/)domain/" }],
    };

    const answers = configToAnswers(config);
    expect(answers.layers).toEqual([{ name: "domain", pattern: "(?:^|/)domain/" }]);
  });

  it("returns undefined layers when config has no layers", () => {
    const config: ProjectConfig = {
      ides: ["claude"],
      projectPurpose: "Test",
      keyPatterns: "",
      gotchas: "",
      generateSnapshot: false,
      snapshotPaths: [],
      stackCorrections: "",
      generatePerPackage: false,
    };

    const answers = configToAnswers(config);
    expect(answers.layers).toBeUndefined();
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

  it("changes when package.json is modified (dependency-aware)", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));

    const hash1 = await computeSnapshotHash(tmpDir, "typescript");

    // Modify package.json (add a new dependency) without touching source files
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0", vue: "^3.0.0" } }),
    );

    const hash2 = await computeSnapshotHash(tmpDir, "typescript");

    expect(hash1).not.toBe(hash2);
  });

  it("includes go.mod for Go projects", async () => {
    tmpDir = await makeTmpDir();
    await fs.writeFile(path.join(tmpDir, "main.go"), "package main");
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module example.com/foo\ngo 1.21\n");

    const hash1 = await computeSnapshotHash(tmpDir, "go");

    await fs.writeFile(path.join(tmpDir, "go.mod"), "module example.com/foo\ngo 1.22\n");

    const hash2 = await computeSnapshotHash(tmpDir, "go");

    expect(hash1).not.toBe(hash2);
  });

  it("includes Cargo.toml for Rust projects", async () => {
    tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/main.rs"), "fn main() {}");
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), '[package]\nname = "foo"\nversion = "0.1.0"\n');

    const hash1 = await computeSnapshotHash(tmpDir, "rust");

    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), '[package]\nname = "foo"\nversion = "0.2.0"\n');

    const hash2 = await computeSnapshotHash(tmpDir, "rust");

    expect(hash1).not.toBe(hash2);
  });

  it("includes pyproject.toml for Python projects", async () => {
    tmpDir = await makeTmpDir();
    await fs.writeFile(path.join(tmpDir, "main.py"), "print('hello')");
    await fs.writeFile(path.join(tmpDir, "pyproject.toml"), '[project]\nname = "foo"\n');

    const hash1 = await computeSnapshotHash(tmpDir, "python");

    await fs.writeFile(path.join(tmpDir, "pyproject.toml"), '[project]\nname = "foo"\nversion = "2.0"\n');

    const hash2 = await computeSnapshotHash(tmpDir, "python");

    expect(hash1).not.toBe(hash2);
  });
});

// ── migrateConfig ───────────────────────────────────────────────────────────

describe("migrateConfig", () => {
  it("migrates v1 to v2: converts ide to ides array", () => {
    const raw: Record<string, unknown> = {
      _version: 1,
      ide: "cursor",
      projectPurpose: "Test",
    };

    const migrated = migrateConfig(raw, 1, 2);

    expect(migrated._version).toBe(2);
    expect(migrated.ides).toEqual(["cursor"]);
    expect(migrated.ide).toBe("cursor"); // original field preserved
  });

  it("migrates v1 to v2: does not overwrite existing ides array", () => {
    const raw: Record<string, unknown> = {
      _version: 1,
      ides: ["claude", "copilot"],
      ide: "cursor",
      projectPurpose: "Test",
    };

    const migrated = migrateConfig(raw, 1, 2);

    expect(migrated.ides).toEqual(["claude", "copilot"]);
  });

  it("migrates v1 to v2: adds analysisDays default", () => {
    const raw: Record<string, unknown> = {
      _version: 1,
      ides: ["claude"],
      projectPurpose: "Test",
    };

    const migrated = migrateConfig(raw, 1, 2);

    expect(migrated.analysisDays).toBe(90);
  });

  it("migrates v1 to v2: preserves existing analysisDays", () => {
    const raw: Record<string, unknown> = {
      _version: 1,
      ides: ["claude"],
      projectPurpose: "Test",
      analysisDays: 30,
    };

    const migrated = migrateConfig(raw, 1, 2);

    expect(migrated.analysisDays).toBe(30);
  });

  it("does not mutate original object", () => {
    const raw: Record<string, unknown> = {
      _version: 1,
      ide: "cursor",
      projectPurpose: "Test",
    };

    migrateConfig(raw, 1, 2);

    // Original should not have ides
    expect(raw.ides).toBeUndefined();
    expect(raw._version).toBe(1);
  });

  it("no-op when versions are equal", () => {
    const raw: Record<string, unknown> = {
      _version: 2,
      ides: ["claude"],
      projectPurpose: "Test",
    };

    const migrated = migrateConfig(raw, 2, 2);

    expect(migrated._version).toBe(2);
    expect(migrated.ides).toEqual(["claude"]);
  });
});

// ── loadConfig with migration ───────────────────────────────────────────────

describe("loadConfig with migration", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("auto-migrates v1 config to v2", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 1,
      ide: "cursor",
      projectPurpose: "Legacy project",
    });

    const config = await loadConfig(tmpDir);

    expect(config).not.toBeNull();
    expect(config?.ides).toEqual(["cursor"]);
    expect(config?.analysisDays).toBe(90);
  });

  it("auto-migrates config with no version to v2", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      ide: "claude",
      projectPurpose: "Very old config",
    });

    const config = await loadConfig(tmpDir);

    expect(config).not.toBeNull();
    expect(config?.ides).toEqual(["claude"]);
    expect(config?.analysisDays).toBe(90);
  });

  it("loads v2 config with analysisDays", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 2,
      ides: ["claude"],
      projectPurpose: "New config",
      analysisDays: 30,
    });

    const config = await loadConfig(tmpDir);

    expect(config).not.toBeNull();
    expect(config?.analysisDays).toBe(30);
  });

  it("preserves analysisDays through save round-trip", async () => {
    tmpDir = await makeTmpDir();
    await writeConfig(tmpDir, {
      _version: 2,
      ides: ["claude"],
      projectPurpose: "Test",
      analysisDays: 45,
    });

    await saveConfig(tmpDir, sampleAnswers);
    const loaded = await loadConfig(tmpDir);

    expect(loaded?.analysisDays).toBe(45);
  });
});
