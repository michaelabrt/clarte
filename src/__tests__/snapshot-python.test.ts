import { describe, expect, it, vi, beforeEach } from "vitest";

// We need to test the Python extraction functions, which are not exported.
// We'll test them via generateSnapshot with mocked file system.
// Instead, we test by importing the module and using the public API.

// For unit testing the extraction logic, we mock readFileOr and tinyglobby
// to feed controlled Python file content.

vi.mock("../core/utils.js", async () => {
  const actual = await vi.importActual<typeof import("../core/utils.js")>("../core/utils.js");
  return {
    ...actual,
    readFileOr: vi.fn(),
  };
});

vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

vi.mock("../core/graph.js", async () => {
  const actual = await vi.importActual<typeof import("../core/graph.js")>("../core/graph.js");
  return {
    ...actual,
    findUsedExports: () => new Set<string>(),
  };
});

import { generateSnapshot } from "../core/snapshot/snapshot";
import { readFileOr } from "../core/utils";
import { glob } from "tinyglobby";
import type { DetectedContext } from "../core/types";

const mockReadFileOr = vi.mocked(readFileOr);
const mockGlob = vi.mocked(glob);

function makePythonCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test-project",
    language: "python",
    hasTypeScript: false,
    packageManager: "pip",
    linter: "ruff",
    frameworks: [],
    directories: ["app", "models"],
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

describe("Python snapshot extraction", () => {
  it("extracts a simple dataclass", async () => {
    const pyContent = `
from dataclasses import dataclass

@dataclass
class UserProfile:
    name: str
    email: str
    age: int = 0
`;

    mockGlob.mockResolvedValue(["models/user.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("@dataclass");
    expect(result.entries[0].signature).toContain("class UserProfile:");
    expect(result.entries[0].signature).toContain("name: str");
  });

  it("extracts a Pydantic BaseModel", async () => {
    const pyContent = `
from pydantic import BaseModel, EmailStr

class UserCreate(BaseModel):
    name: str
    email: EmailStr
    age: int | None = None
`;

    mockGlob.mockResolvedValue(["schemas/user.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("class UserCreate(BaseModel):");
  });

  it("extracts a TypedDict", async () => {
    const pyContent = `
from typing import TypedDict

class Config(TypedDict):
    debug: bool
    host: str
    port: int
`;

    mockGlob.mockResolvedValue(["types/config.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("class Config(TypedDict):");
  });

  it("extracts a Protocol as interface", async () => {
    const pyContent = `
from typing import Protocol

class Serializable(Protocol):
    def serialize(self) -> bytes: ...
    def deserialize(self, data: bytes) -> None: ...
`;

    mockGlob.mockResolvedValue(["core/protocols.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("interface");
    expect(result.entries[0].signature).toContain("class Serializable(Protocol):");
  });

  it("extracts sync and async function signatures", async () => {
    const pyContent = `
def process_order(order_id: int, user: User) -> OrderResult:
    """Process an order."""
    pass

async def fetch_data(url: str, timeout: float = 30.0) -> dict[str, Any]:
    """Fetch data from a URL."""
    pass
`;

    mockGlob.mockResolvedValue(["services/orders.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(2);
    expect(result.entries[0].category).toBe("function");
    expect(result.entries[0].signature).toContain("def process_order(order_id: int, user: User) -> OrderResult:");
    expect(result.entries[1].category).toBe("function");
    expect(result.entries[1].signature).toContain(
      "async def fetch_data(url: str, timeout: float = 30.0) -> dict[str, Any]:",
    );
  });

  it("skips private functions (starting with _)", async () => {
    const pyContent = `
def public_function() -> None:
    pass

def _private_helper() -> None:
    pass

def __very_private() -> None:
    pass
`;

    mockGlob.mockResolvedValue(["utils/helpers.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].signature).toContain("public_function");
  });

  it("extracts type aliases", async () => {
    const pyContent = `
from typing import NewType, Callable

UserID = NewType("UserID", int)
Callback = Callable[[str, int], bool]
`;

    mockGlob.mockResolvedValue(["types/aliases.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(2);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("UserID = NewType");
    expect(result.entries[1].signature).toContain("Callback = Callable");
  });

  it("renders python code blocks in markdown", async () => {
    const pyContent = `
from pydantic import BaseModel

class User(BaseModel):
    name: str
    email: str

def get_user(user_id: int) -> User:
    pass
`;

    mockGlob.mockResolvedValue(["models/user.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.markdown).toContain("```python");
    expect(result.markdown).not.toContain("```ts");
  });

  it("handles multi-line function signature", async () => {
    const pyContent = `
def create_order(
    user_id: int,
    items: list[OrderItem],
    discount: float = 0.0,
) -> Order:
    pass
`;

    mockGlob.mockResolvedValue(["services/orders.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makePythonCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].signature).toContain("def create_order(");
    expect(result.entries[0].signature).toContain(") -> Order:");
  });
});
