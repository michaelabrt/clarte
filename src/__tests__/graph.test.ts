import { describe, expect, it } from "vitest";
import {
  parseJsImports,
  parsePythonImports,
  parseGoImports,
  parseRustImports,
} from "../graph.js";

describe("parseJsImports", () => {
  it("parses named imports", () => {
    const result = parseJsImports(`import { foo, bar } from './utils'`);
    expect(result).toEqual([
      { specifier: "./utils", importedNames: ["foo", "bar"] },
    ]);
  });

  it("parses default imports", () => {
    const result = parseJsImports(`import React from 'react'`);
    expect(result).toEqual([
      { specifier: "react", importedNames: ["React"] },
    ]);
  });

  it("parses default + named imports", () => {
    const result = parseJsImports(
      `import React, { useState, useEffect } from 'react'`,
    );
    expect(result).toEqual([
      { specifier: "react", importedNames: ["React", "useState", "useEffect"] },
    ]);
  });

  it("parses namespace imports (* as)", () => {
    const result = parseJsImports(`import * as path from 'node:path'`);
    expect(result).toEqual([
      { specifier: "node:path", importedNames: [] },
    ]);
  });

  it("parses type-only imports", () => {
    const result = parseJsImports(
      `import type { Foo, Bar } from './types'`,
    );
    expect(result).toEqual([
      { specifier: "./types", importedNames: ["Foo", "Bar"] },
    ]);
  });

  it("parses side-effect imports", () => {
    const result = parseJsImports(`import './polyfills'`);
    expect(result).toEqual([
      { specifier: "./polyfills", importedNames: [] },
    ]);
  });

  it("parses require calls", () => {
    const result = parseJsImports(`const fs = require('fs')`);
    expect(result).toEqual([
      { specifier: "fs", importedNames: [] },
    ]);
  });

  it("parses aliased named imports", () => {
    const result = parseJsImports(
      `import { foo as bar, baz as qux } from './utils'`,
    );
    expect(result).toEqual([
      { specifier: "./utils", importedNames: ["foo", "baz"] },
    ]);
  });

});

describe("parsePythonImports", () => {
  it("parses standard from-import", () => {
    const result = parsePythonImports(`from os.path import join, dirname`);
    expect(result).toEqual([
      { specifier: "os.path", importedNames: ["join", "dirname"] },
    ]);
  });

  it("parses relative imports (single dot)", () => {
    const result = parsePythonImports(`from . import utils`);
    expect(result).toEqual([
      { specifier: ".", importedNames: ["utils"] },
    ]);
  });

  it("parses plain import statements", () => {
    const result = parsePythonImports(`import os, sys`);
    expect(result).toEqual([
      { specifier: "os", importedNames: [] },
      { specifier: "sys", importedNames: [] },
    ]);
  });

  it("parses multi-import with aliases", () => {
    const result = parsePythonImports(
      `from collections import OrderedDict as OD, defaultdict`,
    );
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
    expect(result).toEqual([
      { specifier: "crate::config::Settings", importedNames: ["Settings"] },
    ]);
  });

  it("parses glob imports with braces", () => {
    const result = parseRustImports(`use crate::foo::{Bar, Baz}`);
    expect(result).toEqual([
      { specifier: "crate::foo::{Bar, Baz}", importedNames: ["Bar", "Baz"] },
    ]);
  });

  it("parses mod declarations", () => {
    const result = parseRustImports(`mod config;`);
    expect(result).toEqual([
      { specifier: "config", importedNames: [] },
    ]);
  });

});
