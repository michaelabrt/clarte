import { describe, expect, it, vi, beforeEach } from "vitest";

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

function makeCtx(language: string, overrides?: Partial<DetectedContext>): DetectedContext {
  const defaults: Record<string, Partial<DetectedContext>> = {
    python: {
      language: "python",
      packageManager: "pip",
      linter: "ruff",
      directories: ["app", "models"],
    },
    go: {
      language: "go",
      packageManager: "go",
      linter: "gofmt",
      directories: ["cmd", "internal"],
    },
    rust: {
      language: "rust",
      packageManager: "cargo",
      linter: "rustfmt",
      directories: ["src"],
    },
    java: {
      language: "java",
      packageManager: "none",
      linter: "none",
      directories: ["src"],
    },
  };

  return {
    rootDir: "/test-project",
    hasTypeScript: false,
    frameworks: [],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 5000,
    sourceFileCount: 10,
    monorepo: null,
    ...defaults[language],
    ...overrides,
  } as DetectedContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Python: Docstring Extraction ──────────────────────────────────────────────

describe("Python docstring extraction", () => {
  it("appends single-line docstring to function signature", async () => {
    const pyContent = `
def process_order(order: Order) -> Receipt:
    """Process an order and return a receipt."""
    return Receipt()
`;

    mockGlob.mockResolvedValue(["services/orders.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("process_order"));
    if (!entry) throw new Error("expected process_order entry");
    expect(entry.signature).toContain('# "Process an order and return a receipt."');
  });

  it("appends single-line docstring to class header", async () => {
    const pyContent = `
class OrderService:
    """Service for managing customer orders."""

    def handle(self, order: Order) -> None:
        pass
`;

    mockGlob.mockResolvedValue(["services/orders.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const classEntry = result.entries.find((e) => e.signature.includes("class OrderService"));
    if (!classEntry) throw new Error("expected class OrderService entry");
    expect(classEntry.signature).toContain('# "Service for managing customer orders."');
  });

  it("extracts first line of multi-line docstring", async () => {
    const pyContent = `
def complex_function(x: int, y: str) -> bool:
    """Check if x matches the pattern in y.

    This function performs a complex matching algorithm
    that compares the integer value against the string pattern.

    Args:
        x: The integer to check.
        y: The pattern string.
    """
    pass
`;

    mockGlob.mockResolvedValue(["utils/matching.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("complex_function"));
    if (!entry) throw new Error("expected complex_function entry");
    expect(entry.signature).toContain('# "Check if x matches the pattern in y."');
    // Should not include the full docstring body
    expect(entry.signature).not.toContain("Args:");
  });

  it("truncates long docstrings to 80 chars with ellipsis", async () => {
    const pyContent = `
def long_documented(items: list[Item]) -> Result:
    """This is a very long docstring that goes on and on describing what the function does in excessive detail."""
    pass
`;

    mockGlob.mockResolvedValue(["services/items.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("long_documented"));
    if (!entry) throw new Error("expected long_documented entry");
    // The docstring comment should be present
    expect(entry.signature).toContain('# "');
    // Extract the docstring part
    const docPart = entry.signature.split('# "')[1];
    // Should end with ..." (including the closing quote)
    expect(docPart).toContain("...");
    // The docstring portion (between the quotes) should not exceed 80 chars
    const docText = docPart.replace(/"$/, "");
    expect(docText.length).toBeLessThanOrEqual(80);
  });

  it("handles docstrings with single quotes", async () => {
    const pyContent = `
def single_quoted(data: bytes) -> str:
    '''Decode bytes to a UTF-8 string.'''
    return data.decode('utf-8')
`;

    mockGlob.mockResolvedValue(["utils/encoding.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("single_quoted"));
    if (!entry) throw new Error("expected single_quoted entry");
    expect(entry.signature).toContain('# "Decode bytes to a UTF-8 string."');
  });

  it("does not append docstring when none present", async () => {
    const pyContent = `
def no_docstring(x: int) -> int:
    return x + 1
`;

    mockGlob.mockResolvedValue(["utils/math.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("no_docstring"));
    if (!entry) throw new Error("expected no_docstring entry");
    expect(entry.signature).not.toContain("#");
  });

  it("handles multi-line docstring where summary is on the next line", async () => {
    const pyContent = `
def delayed_summary(x: int) -> int:
    """
    Compute the delayed value of x.
    """
    return x
`;

    mockGlob.mockResolvedValue(["utils/compute.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("delayed_summary"));
    if (!entry) throw new Error("expected delayed_summary entry");
    expect(entry.signature).toContain('# "Compute the delayed value of x."');
  });

  it("appends docstring to async function", async () => {
    const pyContent = `
async def fetch_user(user_id: int) -> User:
    """Fetch a user by their unique ID."""
    pass
`;

    mockGlob.mockResolvedValue(["services/users.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const entry = result.entries.find((e) => e.signature.includes("fetch_user"));
    if (!entry) throw new Error("expected fetch_user entry");
    expect(entry.signature).toContain('# "Fetch a user by their unique ID."');
  });

  it("appends docstring to class method", async () => {
    const pyContent = `
class UserManager:
    def create_user(self, name: str) -> User:
        """Create a new user with the given name."""
        pass
`;

    mockGlob.mockResolvedValue(["services/users.py"] as string[]);
    mockReadFileOr.mockResolvedValue(pyContent);

    const result = await generateSnapshot(makeCtx("python"), []);

    const methodEntry = result.entries.find((e) => e.signature.includes("create_user"));
    if (!methodEntry) throw new Error("expected create_user entry");
    expect(methodEntry.signature).toContain('# "Create a new user with the given name."');
  });
});

// ── Go: Receiver Method Grouping ──────────────────────────────────────────────

describe("Go receiver method grouping", () => {
  it("rewrites method signatures to (ReceiverType).Method format", async () => {
    const goContent = `package models

func (s *Server) Handle(ctx context.Context) error {
	return nil
}
`;

    mockGlob.mockResolvedValue(["internal/server.go"] as string[]);
    mockReadFileOr.mockResolvedValue(goContent);

    const result = await generateSnapshot(makeCtx("go"), []);

    const entry = result.entries.find((e) => e.signature.includes("Handle"));
    if (!entry) throw new Error("expected Handle entry");
    expect(entry.signature).toBe("(Server).Handle(ctx context.Context) error");
    expect(entry.category).toBe("function");
  });

  it("rewrites value receiver methods", async () => {
    const goContent = `package models

func (u User) String() string {
	return u.Name
}
`;

    mockGlob.mockResolvedValue(["models/user.go"] as string[]);
    mockReadFileOr.mockResolvedValue(goContent);

    const result = await generateSnapshot(makeCtx("go"), []);

    const entry = result.entries.find((e) => e.signature.includes("String"));
    if (!entry) throw new Error("expected String entry");
    expect(entry.signature).toBe("(User).String() string");
  });

  it("extracts struct, methods, and standalone functions from same file", async () => {
    const goContent = `package models

type Server struct {
	Addr string
	Port int
}

func (s *Server) Start() error {
	return nil
}

func (s *Server) Stop() error {
	return nil
}

func NewServer(addr string) *Server {
	return &Server{Addr: addr}
}
`;

    mockGlob.mockResolvedValue(["models/server.go"] as string[]);
    mockReadFileOr.mockResolvedValue(goContent);

    const result = await generateSnapshot(makeCtx("go"), []);

    const sigs = result.entries.map((e) => e.signature);

    // All symbols should be present
    expect(sigs.some((s) => s.includes("type Server struct"))).toBe(true);
    expect(sigs.some((s) => s.includes("(Server).Start() error"))).toBe(true);
    expect(sigs.some((s) => s.includes("(Server).Stop() error"))).toBe(true);
    expect(sigs.some((s) => s.includes("func NewServer"))).toBe(true);

    // Methods use (ReceiverType).Method format; standalone functions use func prefix
    const methodEntries = result.entries.filter((e) => e.signature.startsWith("(Server)."));
    expect(methodEntries.length).toBe(2);
    expect(methodEntries.every((e) => e.category === "function")).toBe(true);

    const standaloneEntries = result.entries.filter((e) => e.signature.startsWith("func "));
    expect(standaloneEntries.length).toBe(1);
    expect(standaloneEntries[0].signature).toContain("NewServer");
  });

  it("keeps standalone functions unchanged", async () => {
    const goContent = `package handlers

func HandleRequest(w http.ResponseWriter, r *http.Request) {
	// handler body
}
`;

    mockGlob.mockResolvedValue(["handlers/main.go"] as string[]);
    mockReadFileOr.mockResolvedValue(goContent);

    const result = await generateSnapshot(makeCtx("go"), []);

    const entry = result.entries.find((e) => e.signature.includes("HandleRequest"));
    if (!entry) throw new Error("expected HandleRequest entry");
    // Standalone functions should retain the "func" prefix
    expect(entry.signature).toContain("func HandleRequest");
  });

  it("handles methods for receiver type not defined in same file", async () => {
    // When the struct is defined in another file, methods should still
    // be extracted with the (ReceiverType).Method format
    const goContent = `package models

func (u *User) FullName() string {
	return u.First + " " + u.Last
}
`;

    mockGlob.mockResolvedValue(["models/user_methods.go"] as string[]);
    mockReadFileOr.mockResolvedValue(goContent);

    const result = await generateSnapshot(makeCtx("go"), []);

    const entry = result.entries.find((e) => e.signature.includes("FullName"));
    if (!entry) throw new Error("expected FullName entry");
    expect(entry.signature).toBe("(User).FullName() string");
  });

  it("handles multiple struct types with their respective methods", async () => {
    const goContent = `package models

type Reader struct {
	Source string
}

func (r *Reader) Read(buf []byte) (int, error) {
	return 0, nil
}

type Writer struct {
	Dest string
}

func (w *Writer) Write(data []byte) (int, error) {
	return 0, nil
}
`;

    mockGlob.mockResolvedValue(["models/io.go"] as string[]);
    mockReadFileOr.mockResolvedValue(goContent);

    const result = await generateSnapshot(makeCtx("go"), []);

    const sigs = result.entries.map((e) => e.signature);

    // Both structs and their methods should be present
    expect(sigs.some((s) => s.includes("type Reader struct"))).toBe(true);
    expect(sigs.some((s) => s.includes("(Reader).Read"))).toBe(true);
    expect(sigs.some((s) => s.includes("type Writer struct"))).toBe(true);
    expect(sigs.some((s) => s.includes("(Writer).Write"))).toBe(true);

    // Methods should use the (ReceiverType).Method format
    const readerMethod = result.entries.find((e) => e.signature.includes("(Reader).Read"));
    if (!readerMethod) throw new Error("expected (Reader).Read entry");
    expect(readerMethod.signature).toContain("(Reader).Read(buf []byte) (int, error)");

    const writerMethod = result.entries.find((e) => e.signature.includes("(Writer).Write"));
    if (!writerMethod) throw new Error("expected (Writer).Write entry");
    expect(writerMethod.signature).toContain("(Writer).Write(data []byte) (int, error)");
  });
});

// ── Rust: Where Clause Preservation ───────────────────────────────────────────

describe("Rust where clause preservation", () => {
  it("preserves where clause in function signature", async () => {
    const rsContent = `pub fn process<T>(item: T) -> Result<()>
where
    T: Serialize + Send,
{
    todo!()
}
`;

    mockGlob.mockResolvedValue(["src/handlers.rs"] as string[]);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeCtx("rust"), []);

    const entry = result.entries.find((e) => e.signature.includes("process"));
    if (!entry) throw new Error("expected process entry");
    expect(entry.signature).toContain("where");
    expect(entry.signature).toContain("T: Serialize + Send");
    // Should not include the opening brace
    expect(entry.signature).not.toContain("{");
  });

  it("preserves multi-bound where clause", async () => {
    const rsContent = `pub fn transform<T, U>(input: T) -> Result<U>
where
    T: Serialize + Clone,
    U: DeserializeOwned + Default,
{
    todo!()
}
`;

    mockGlob.mockResolvedValue(["src/transform.rs"] as string[]);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeCtx("rust"), []);

    const entry = result.entries.find((e) => e.signature.includes("transform"));
    if (!entry) throw new Error("expected transform entry");
    expect(entry.signature).toContain("T: Serialize + Clone");
    expect(entry.signature).toContain("U: DeserializeOwned + Default");
    expect(entry.signature).not.toContain("{");
  });

  it("preserves async fn with where clause", async () => {
    const rsContent = `pub async fn fetch<T>(url: &str) -> Result<T>
where
    T: DeserializeOwned,
{
    todo!()
}
`;

    mockGlob.mockResolvedValue(["src/client.rs"] as string[]);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeCtx("rust"), []);

    const entry = result.entries.find((e) => e.signature.includes("fetch"));
    if (!entry) throw new Error("expected fetch entry");
    expect(entry.signature).toContain("pub async fn fetch");
    expect(entry.signature).toContain("where");
    expect(entry.signature).toContain("T: DeserializeOwned");
  });

  it("still handles functions without where clauses", async () => {
    const rsContent = `pub fn simple_function(x: i32) -> i32 {
    x + 1
}
`;

    mockGlob.mockResolvedValue(["src/math.rs"] as string[]);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeCtx("rust"), []);

    const entry = result.entries.find((e) => e.signature.includes("simple_function"));
    if (!entry) throw new Error("expected simple_function entry");
    expect(entry.signature).toBe("pub fn simple_function(x: i32) -> i32");
    expect(entry.signature).not.toContain("{");
  });

  it("handles where clause with lifetime bounds", async () => {
    const rsContent = `pub fn parse<'a, T>(input: &'a str) -> Result<T>
where
    T: Deserialize<'a>,
{
    todo!()
}
`;

    mockGlob.mockResolvedValue(["src/parser.rs"] as string[]);
    mockReadFileOr.mockResolvedValue(rsContent);

    const result = await generateSnapshot(makeCtx("rust"), []);

    const entry = result.entries.find((e) => e.signature.includes("parse"));
    if (!entry) throw new Error("expected parse entry");
    expect(entry.signature).toContain("where");
    expect(entry.signature).toContain("T: Deserialize<'a>");
  });
});

// ── Java: Improved Annotation Capture ─────────────────────────────────────────

describe("Java improved annotation capture", () => {
  it("captures @GetMapping and @PostMapping on methods", async () => {
    const javaContent = `package com.example.controllers;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        return service.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody UserDTO dto) {
        return service.create(dto);
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/controllers/UserController.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    const getMethod = result.entries.find((e) => e.signature.includes("getUser"));
    if (!getMethod) throw new Error("expected getUser entry");
    expect(getMethod.signature).toContain('@GetMapping("/{id}")');

    const postMethod = result.entries.find((e) => e.signature.includes("createUser"));
    if (!postMethod) throw new Error("expected createUser entry");
    expect(postMethod.signature).toContain("@PostMapping");
  });

  it("captures @Transactional on methods", async () => {
    const javaContent = `package com.example.services;

@Service
public class OrderService {

    @Transactional
    public Order processOrder(Long orderId) {
        return repository.process(orderId);
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/services/OrderService.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    const classEntry = result.entries.find((e) => e.signature.includes("OrderService"));
    if (!classEntry) throw new Error("expected OrderService entry");
    expect(classEntry.signature).toContain("@Service");

    const methodEntry = result.entries.find((e) => e.signature.includes("processOrder"));
    if (!methodEntry) throw new Error("expected processOrder entry");
    expect(methodEntry.signature).toContain("@Transactional");
  });

  it("captures @Service, @Repository, @Controller annotations on classes", async () => {
    const javaContent = `package com.example;

@Repository
public class UserRepository {

    public User findById(Long id) {
        return null;
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/UserRepository.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    const entry = result.entries.find((e) => e.signature.includes("UserRepository"));
    if (!entry) throw new Error("expected UserRepository entry");
    expect(entry.signature).toContain("@Repository");
  });

  it("captures @Entity and @Table annotations", async () => {
    const javaContent = `package com.example.entities;

@Entity
@Table(name = "users")
public class User {

    public Long getId() {
        return id;
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/entities/User.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    const entry = result.entries.find((e) => e.signature.includes("public class User"));
    if (!entry) throw new Error("expected public class User entry");
    expect(entry.signature).toContain("@Entity");
    expect(entry.signature).toContain("@Table");
  });

  it("captures JPA field annotations on public fields", async () => {
    const javaContent = `package com.example.entities;

@Entity
public class Order {

    @ManyToOne
    @JoinColumn(name = "user_id")
    public User customer;

    @Column(nullable = false)
    public String status;

    public Long getId() {
        return id;
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/entities/Order.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    // Public fields with significant JPA annotations should be captured
    const customerField = result.entries.find((e) => e.signature.includes("public User customer"));
    if (!customerField) throw new Error("expected public User customer entry");
    expect(customerField.signature).toContain("@ManyToOne");

    const statusField = result.entries.find((e) => e.signature.includes("public String status"));
    if (!statusField) throw new Error("expected public String status entry");
    expect(statusField.signature).toContain("@Column");
  });

  it("preserves annotation parameters with spaces", async () => {
    const javaContent = `package com.example;

@RestController
public class ApiController {

    @GetMapping(value = "/users", produces = "application/json")
    public List<User> listUsers() {
        return service.findAll();
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/ApiController.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    const entry = result.entries.find((e) => e.signature.includes("listUsers"));
    if (!entry) throw new Error("expected listUsers entry");
    // The full @GetMapping annotation with parameters should be preserved
    expect(entry.signature).toContain("@GetMapping");
    expect(entry.signature).toContain("/users");
  });

  it("does not capture public fields without significant annotations", async () => {
    const javaContent = `package com.example;

public class SimpleClass {

    public String name;

    public String getName() {
        return name;
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/SimpleClass.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    // The field without significant annotations should not be captured
    const fieldEntry = result.entries.find(
      (e) => e.signature.includes("public String name") && !e.signature.includes("getName"),
    );
    expect(fieldEntry).toBeUndefined();

    // But the method should still be captured
    const methodEntry = result.entries.find((e) => e.signature.includes("getName"));
    expect(methodEntry).toBeDefined();
  });

  it("captures @RestController and @RequestMapping on class header", async () => {
    const javaContent = `package com.example;

@RestController
@RequestMapping("/api/v2")
public class V2Controller {

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/V2Controller.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeCtx("java"), []);

    const classEntry = result.entries.find((e) => e.signature.includes("V2Controller"));
    if (!classEntry) throw new Error("expected V2Controller entry");
    expect(classEntry.signature).toContain("@RestController");
    expect(classEntry.signature).toContain('@RequestMapping("/api/v2")');

    const deleteMethod = result.entries.find((e) => e.signature.includes("delete"));
    if (!deleteMethod) throw new Error("expected delete entry");
    expect(deleteMethod.signature).toContain('@DeleteMapping("/{id}")');
  });
});
