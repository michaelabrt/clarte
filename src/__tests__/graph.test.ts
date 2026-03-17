import { describe, expect, it, beforeAll } from "vitest";
import {
  parseJsImports,
  parsePythonImports,
  parseGoImports,
  parseRustImports,
  resolveImport,
  detectPythonPackageRoots,
} from "../core/graph/import-resolution";
import { initTreeSitter } from "../core/parsers/init";

beforeAll(async () => {
  await initTreeSitter();
});

describe("parseJsImports", () => {
  it("parses named imports", () => {
    const result = parseJsImports(`import { foo, bar } from './utils'`);
    expect(result).toEqual([{ specifier: "./utils", importedNames: ["foo", "bar"], isTypeOnly: false }]);
  });

  it("parses default imports", () => {
    const result = parseJsImports(`import React from 'react'`);
    expect(result).toEqual([{ specifier: "react", importedNames: ["React"], isTypeOnly: false }]);
  });

  it("parses default + named imports", () => {
    const result = parseJsImports(`import React, { useState, useEffect } from 'react'`);
    expect(result).toEqual([
      { specifier: "react", importedNames: ["React", "useState", "useEffect"], isTypeOnly: false },
    ]);
  });

  it("parses namespace imports (* as)", () => {
    const result = parseJsImports(`import * as path from 'node:path'`);
    // Alias preserved in "* as <alias>" format so resolution can match objectName
    expect(result).toEqual([{ specifier: "node:path", importedNames: ["* as path"], isTypeOnly: false }]);
  });

  it("parses type-only imports", () => {
    const result = parseJsImports(`import type { Foo, Bar } from './types'`);
    expect(result).toEqual([{ specifier: "./types", importedNames: ["Foo", "Bar"], isTypeOnly: true }]);
  });

  it("parses side-effect imports", () => {
    const result = parseJsImports(`import './polyfills'`);
    expect(result).toEqual([{ specifier: "./polyfills", importedNames: [], isTypeOnly: false }]);
  });

  it("parses require calls", () => {
    const result = parseJsImports(`const fs = require('fs')`);
    expect(result).toEqual([{ specifier: "fs", importedNames: [] }]);
  });

  it("parses aliased named imports", () => {
    const result = parseJsImports(`import { foo as bar, baz as qux } from './utils'`);
    expect(result).toEqual([{ specifier: "./utils", importedNames: ["foo", "baz"], isTypeOnly: false }]);
  });
});

describe("parsePythonImports", () => {
  it("parses standard from-import", () => {
    const result = parsePythonImports(`from os.path import join, dirname`);
    expect(result).toEqual([{ specifier: "os.path", importedNames: ["join", "dirname"] }]);
  });

  it("parses relative imports (single dot)", () => {
    const result = parsePythonImports(`from . import utils`);
    expect(result).toEqual([{ specifier: ".", importedNames: ["utils"] }]);
  });

  it("parses plain import statements", () => {
    const result = parsePythonImports(`import os, sys`);
    expect(result).toEqual([
      { specifier: "os", importedNames: [] },
      { specifier: "sys", importedNames: [] },
    ]);
  });

  it("parses multi-import with aliases", () => {
    const result = parsePythonImports(`from collections import OrderedDict as OD, defaultdict`);
    expect(result).toEqual([
      {
        specifier: "collections",
        importedNames: ["OrderedDict", "defaultdict"],
      },
    ]);
  });
});

describe("parseGoImports", () => {
  it("parses single import", () => {
    const result = parseGoImports(`import "fmt"`);
    expect(result).toEqual([{ specifier: "fmt", importedNames: [] }]);
  });

  it("parses block imports", () => {
    const result = parseGoImports(`import (
  "fmt"
  "os"
)`);
    expect(result).toEqual([
      { specifier: "fmt", importedNames: [] },
      { specifier: "os", importedNames: [] },
    ]);
  });

  it("filters comments in import blocks", () => {
    const result = parseGoImports(`import (
  "fmt"
  // "deprecated/pkg"
  "os"
)`);
    expect(result).toEqual([
      { specifier: "fmt", importedNames: [] },
      { specifier: "os", importedNames: [] },
    ]);
  });
});

describe("parseRustImports", () => {
  it("parses standard use", () => {
    const result = parseRustImports(`use crate::config::Settings;`);
    expect(result).toEqual([{ specifier: "crate::config::Settings", importedNames: ["Settings"] }]);
  });

  it("parses glob imports with braces", () => {
    const result = parseRustImports(`use crate::foo::{Bar, Baz}`);
    expect(result).toEqual([{ specifier: "crate::foo::{Bar, Baz}", importedNames: ["Bar", "Baz"] }]);
  });

  it("parses mod declarations", () => {
    const result = parseRustImports(`mod config;`);
    expect(result).toEqual([{ specifier: "mod::config", importedNames: [] }]);
  });
});

describe("parseJsImports ignores comments", () => {
  it("ignores imports in single-line comments", () => {
    const result = parseJsImports(`import { foo } from './real';\n// import { fake } from './fake';`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./real");
  });

  it("ignores imports in block comments", () => {
    const result = parseJsImports(`import { foo } from './real';\n/* import { fake } from './fake'; */`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./real");
  });

  it("ignores imports in multi-line block comments", () => {
    const result = parseJsImports(`
import { foo } from './real';
/*
import { fake } from './fake';
import { another } from './also-fake';
*/`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./real");
  });

  it("handles inline comment after real import", () => {
    const result = parseJsImports(`import { foo } from './real'; // import { x } from './y'`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./real");
  });

  it("ignores require() in comments", () => {
    const result = parseJsImports(`const a = require('./real');\n// const b = require('./fake');`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./real");
  });
});

describe("parseJsImports dynamic imports", () => {
  it("flags dynamic import() as isDynamic", () => {
    const result = parseJsImports(`const mod = import('./lazy-module')`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./lazy-module");
    expect(result[0].isDynamic).toBe(true);
  });

  it("does not flag static imports as isDynamic", () => {
    const result = parseJsImports(`import { foo } from './utils'`);
    expect(result).toHaveLength(1);
    expect(result[0].isDynamic).toBeFalsy();
  });

  it("handles mix of static and dynamic imports", () => {
    const result = parseJsImports(`
import { foo } from './static';
const lazy = import('./dynamic');
`);
    expect(result).toHaveLength(2);
    const staticImport = result.find((r) => r.specifier === "./static");
    const dynamicImport = result.find((r) => r.specifier === "./dynamic");
    expect(staticImport?.isDynamic).toBeFalsy();
    expect(dynamicImport?.isDynamic).toBe(true);
  });

  it("flags require() as not dynamic", () => {
    const result = parseJsImports(`const fs = require('fs')`);
    expect(result).toHaveLength(1);
    expect(result[0].isDynamic).toBeFalsy();
  });
});

describe("parsePythonImports ignores comments", () => {
  it("ignores imports in comments", () => {
    const result = parsePythonImports(`from real import foo\n# from fake import bar`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("real");
  });

  it("preserves imports after comments on separate lines", () => {
    const result = parsePythonImports(`# comment\nfrom real import foo`);
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("real");
  });
});

describe("detectPythonPackageRoots", () => {
  it("detects top-level package from __init__.py", () => {
    const files = ["app/__init__.py", "app/models/__init__.py", "app/models/user.py", "tests/test_app.py"];
    expect(detectPythonPackageRoots(files)).toEqual(["app"]);
  });

  it("detects multiple package roots", () => {
    const files = ["app/__init__.py", "lib/__init__.py", "lib/utils.py"];
    const roots = detectPythonPackageRoots(files);
    expect(roots).toContain("app");
    expect(roots).toContain("lib");
  });

  it("returns empty for no __init__.py files", () => {
    const files = ["main.py", "utils.py"];
    expect(detectPythonPackageRoots(files)).toEqual([]);
  });
});

describe("Python absolute import resolution", () => {
  const allFiles = new Set([
    "app/__init__.py",
    "app/models/__init__.py",
    "app/models/user.py",
    "app/config.py",
    "app/routes/users.py",
    "tests/test_app.py",
  ]);

  it("resolves absolute import to .py file", () => {
    const result = resolveImport("app.config", "app/routes/users.py", "python", allFiles, {
      pythonPackageRoots: ["app"],
    });
    expect(result).toBe("app/config.py");
  });

  it("resolves absolute import to __init__.py", () => {
    const result = resolveImport("app.models", "app/routes/users.py", "python", allFiles, {
      pythonPackageRoots: ["app"],
    });
    expect(result).toBe("app/models/__init__.py");
  });

  it("resolves absolute import to nested module", () => {
    const result = resolveImport("app.models.user", "tests/test_app.py", "python", allFiles, {
      pythonPackageRoots: ["app"],
    });
    expect(result).toBe("app/models/user.py");
  });

  it("returns null for unknown package (external)", () => {
    const result = resolveImport("flask", "app/routes/users.py", "python", allFiles, {
      pythonPackageRoots: ["app"],
    });
    expect(result).toBeNull();
  });

  it("still resolves relative imports", () => {
    const result = resolveImport("..config", "app/routes/users.py", "python", allFiles, {
      pythonPackageRoots: ["app"],
    });
    expect(result).toBe("app/config.py");
  });
});
