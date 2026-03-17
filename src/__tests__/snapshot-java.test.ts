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

function makeJavaCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test-project",
    language: "java",
    hasTypeScript: false,
    packageManager: "none",
    linter: "none",
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

describe("Java snapshot extraction", () => {
  it("extracts a public class with methods", async () => {
    const javaContent = `package com.example.models;

public class UserService {

    public User findById(Long id) {
        return repository.findById(id);
    }

    public List<User> findAll() {
        return repository.findAll();
    }

    private void validateUser(User user) {
        // private, should not be extracted
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/models/UserService.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    // class header + 2 public methods
    expect(result.entries.length).toBe(3);
    const sigs = result.entries.map((e) => e.signature);
    expect(sigs.some((s) => s.includes("public class UserService"))).toBe(true);
    expect(sigs.some((s) => s.includes("public User findById(Long id)"))).toBe(true);
    expect(sigs.some((s) => s.includes("public List<User> findAll()"))).toBe(true);
    // private method should not be extracted
    expect(sigs.some((s) => s.includes("validateUser"))).toBe(false);
  });

  it("extracts a public interface", async () => {
    const javaContent = `package com.example.repos;

public interface UserRepository {
    User findById(Long id);
    List<User> findAll();
    void save(User user);
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/repos/UserRepository.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("interface");
    expect(result.entries[0].signature).toContain("public interface UserRepository {");
  });

  it("extracts a public enum", async () => {
    const javaContent = `package com.example.types;

public enum Status {
    ACTIVE,
    INACTIVE,
    PENDING;
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/types/Status.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("public enum Status {");
  });

  it("extracts a public record", async () => {
    const javaContent = `package com.example.dto;

public record UserDTO(String name, String email, int age) {
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/dto/UserDTO.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].category).toBe("type");
    expect(result.entries[0].signature).toContain("public record UserDTO(String name, String email, int age)");
  });

  it("captures annotations on class declarations", async () => {
    const javaContent = `package com.example.controllers;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        return service.findById(id);
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/controllers/UserController.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    const classSig = result.entries.find((e) => e.signature.includes("UserController"));
    expect(classSig).toBeDefined();
    expect(classSig?.signature).toContain("@RestController");
    expect(classSig?.signature).toContain("@RequestMapping");
  });

  it("skips @Generated annotated items", async () => {
    const javaContent = `package com.example;

@Generated("lombok")
public class GeneratedDTO {
    private String name;
}

public class RealService {
    public void doWork() {
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/App.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    const sigs = result.entries.map((e) => e.signature);
    expect(sigs.some((s) => s.includes("GeneratedDTO"))).toBe(false);
    expect(sigs.some((s) => s.includes("RealService"))).toBe(true);
  });

  it("extracts methods with nested generic return types", async () => {
    const javaContent = `package com.example;

public class DataService {

    public Map<String, List<Integer>> getMapping() {
        return new HashMap<>();
    }

    public <T extends Comparable<T>> List<T> sorted(List<T> items) {
        return items.stream().sorted().toList();
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/DataService.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    const sigs = result.entries.map((e) => e.signature);
    // Should extract both methods despite nested generics
    expect(sigs.some((s) => s.includes("Map<String, List<Integer>> getMapping()"))).toBe(true);
    expect(sigs.some((s) => s.includes("sorted(List<T> items)"))).toBe(true);
  });

  it("renders java code blocks in markdown", async () => {
    const javaContent = `package com.example;

public class App {
    public static void main(String[] args) {
    }
}
`;

    mockGlob.mockResolvedValue(["src/main/java/com/example/App.java"] as string[]);
    mockReadFileOr.mockResolvedValue(javaContent);

    const result = await generateSnapshot(makeJavaCtx(), []);

    expect(result.markdown).toContain("```java");
    expect(result.markdown).not.toContain("```ts");
  });
});
