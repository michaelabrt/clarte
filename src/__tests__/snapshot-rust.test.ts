import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    readFileOr: vi.fn(),
  };
});

vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

vi.mock("../graph.js", async () => {
  const actual = await vi.importActual<typeof import("../graph.js")>("../graph.js");
  return {
    ...actual,
    findUsedExports: () => new Set<string>(),
  };
});

import { generateSnapshot } from "../snapshot/snapshot.js";
import { readFileOr } from "../utils.js";
import { glob } from "tinyglobby";
import type { DetectedContext } from "../types.js";

const mockReadFileOr = vi.mocked(readFileOr);
const mockGlob = vi.mocked(glob);

function makeRustCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test-project",
    language: "rust",
    hasTypeScript: false,
    packageManager: "cargo",
    linter: "rustfmt",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 5000,
    sourceFileCount: 10,
    monorepo: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Rust snapshot extraction", () => {
  it("extracts a pub struct", async () => {
    const rsContent = `pub struct User {
    pub id: u64,
    pub name: String,
    pub email: String,
}
`;

    mockGlob.mockResolvedValue(["src/models.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("pub struct User {");
    expect(result.entries[0].signature).toContain("pub name: String");
  });

  it("extracts a pub enum", async () => {
    const rsContent = `pub enum Status {
    Active,
    Inactive,
    Pending,
}
`;

    mockGlob.mockResolvedValue(["src/types.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("pub enum Status {");
  });

  it("extracts a pub trait as interface", async () => {
    const rsContent = `pub trait Repository {
    fn find_by_id(&self, id: u64) -> Option<User>;
    fn save(&mut self, user: User) -> Result<(), Error>;
}
`;

    mockGlob.mockResolvedValue(["src/traits.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("interface");
    expect(result.entries[0].signature).toContain("pub trait Repository {");
  });

  it("extracts pub fn signatures", async () => {
    const rsContent = `pub fn process_request(req: Request) -> Response {
    todo!()
}

pub async fn fetch_data(url: &str) -> Result<Data, Error> {
    todo!()
}
`;

    mockGlob.mockResolvedValue(["src/handlers.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(2);
    const sigs = result.entries.map((e) => e.signature);
    expect(sigs.some((s) => s.includes("pub fn process_request(req: Request) -> Response"))).toBe(true);
    expect(sigs.some((s) => s.includes("pub async fn fetch_data(url: &str) -> Result<Data, Error>"))).toBe(true);
  });

  it("skips non-pub items", async () => {
    const rsContent = `struct PrivateStruct {
    field: String,
}

fn private_func() {}

pub struct PublicStruct {
    pub field: String,
}

pub fn public_func() -> bool {
    true
}
`;

    mockGlob.mockResolvedValue(["src/lib.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(2);
    const sigs = result.entries.map((e) => e.signature);
    expect(sigs.some((s) => s.includes("PublicStruct"))).toBe(true);
    expect(sigs.some((s) => s.includes("public_func"))).toBe(true);
    expect(sigs.some((s) => s.includes("PrivateStruct"))).toBe(false);
  });

  it("skips #[cfg(test)] modules", async () => {
    const rsContent = `pub fn real_function() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn test_helper() -> bool {
        true
    }
}
`;

    mockGlob.mockResolvedValue(["src/lib.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].signature).toContain("pub fn real_function()");
  });

  it("extracts pub type aliases", async () => {
    const rsContent = `pub type Result<T> = std::result::Result<T, AppError>;
`;

    mockGlob.mockResolvedValue(["src/types.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("pub type Result<T> = std::result::Result<T, AppError>");
  });

  it("renders rust code blocks in markdown", async () => {
    const rsContent = `pub struct Config {
    pub debug: bool,
}
`;

    mockGlob.mockResolvedValue(["src/config.rs"] as any);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeRustCtx(), []);

    expect(result.markdown).toContain("```rust");
    expect(result.markdown).not.toContain("```ts");
  });
});
