import { describe, expect, it, beforeAll } from "vitest";
import { parsePythonImports } from "../core/graph/import-resolution.js";
import { initTreeSitter } from "../core/parsers/init.js";

beforeAll(async () => {
  await initTreeSitter();
});

describe("Python TYPE_CHECKING detection (§3.24)", () => {
  it("marks imports inside TYPE_CHECKING block as type-only", () => {
    const source = `
from __future__ import annotations
from typing import TYPE_CHECKING

import os

if TYPE_CHECKING:
    from mypackage.models import User
    from mypackage.services import AuthService

from mypackage.utils import helper
`;

    const imports = parsePythonImports(source);

    // os import: not type-only
    const osImport = imports.find((i) => i.specifier === "os");
    expect(osImport).toBeDefined();
    expect(osImport?.isTypeOnly).toBeUndefined();

    // User import: type-only (inside TYPE_CHECKING)
    const userImport = imports.find((i) => i.specifier === "mypackage.models");
    expect(userImport).toBeDefined();
    expect(userImport?.isTypeOnly).toBe(true);

    // AuthService import: type-only (inside TYPE_CHECKING)
    const authImport = imports.find((i) => i.specifier === "mypackage.services");
    expect(authImport).toBeDefined();
    expect(authImport?.isTypeOnly).toBe(true);

    // helper import: not type-only (after TYPE_CHECKING block)
    const helperImport = imports.find((i) => i.specifier === "mypackage.utils");
    expect(helperImport).toBeDefined();
    expect(helperImport?.isTypeOnly).toBeUndefined();
  });

  it("does NOT mark imports as type-only when no TYPE_CHECKING block exists", () => {
    const source = `
import os
from mypackage.models import User
from mypackage.utils import helper
`;

    const imports = parsePythonImports(source);

    for (const imp of imports) {
      expect(imp.isTypeOnly).toBeUndefined();
    }
  });

  it("handles multiple imports inside TYPE_CHECKING block", () => {
    const source = `
if TYPE_CHECKING:
    from mypackage.models import User, Admin
    import mypackage.cache

from mypackage.utils import helper
`;

    const imports = parsePythonImports(source);

    const modelsImport = imports.find((i) => i.specifier === "mypackage.models");
    expect(modelsImport).toBeDefined();
    expect(modelsImport?.isTypeOnly).toBe(true);
    expect(modelsImport?.importedNames).toContain("User");
    expect(modelsImport?.importedNames).toContain("Admin");

    const cacheImport = imports.find((i) => i.specifier === "mypackage.cache");
    expect(cacheImport).toBeDefined();
    expect(cacheImport?.isTypeOnly).toBe(true);

    const helperImport = imports.find((i) => i.specifier === "mypackage.utils");
    expect(helperImport).toBeDefined();
    expect(helperImport?.isTypeOnly).toBeUndefined();
  });
});
