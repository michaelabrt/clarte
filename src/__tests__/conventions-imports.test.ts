import { describe, expect, it } from "vitest";
import { detectImportOrderingDetailed } from "../core/conventions/imports";

describe("detectImportOrderingDetailed", () => {
  it("returns null ordering for fewer than 3 imports", () => {
    const result = detectImportOrderingDetailed(`
import React from "react";
import { useState } from "react";
`);
    expect(result.ordering).toBeNull();
  });

  it("detects external-first with blank-line separation", () => {
    const result = detectImportOrderingDetailed(`
import React from "react";
import lodash from "lodash";

import { helper } from "./helper";
import { utils } from "../core/utils";
`);
    expect(result.ordering).toBe("external-first, blank-line separated");
  });

  it("detects external-first without blank lines", () => {
    const result = detectImportOrderingDetailed(`
import React from "react";
import lodash from "lodash";
import { helper } from "./helper";
import { utils } from "../core/utils";
`);
    expect(result.ordering).toBe("external-first");
  });

  it("returns null when relative imports come first", () => {
    const result = detectImportOrderingDetailed(`
import { helper } from "./helper";
import { utils } from "../core/utils";
import React from "react";
`);
    expect(result.ordering).toBeNull();
  });

  it("detects alphabetical ordering within groups", () => {
    const result = detectImportOrderingDetailed(`
import axios from "axios";
import lodash from "lodash";
import react from "react";

import { bar } from "./bar";
import { foo } from "./foo";
`);
    expect(result.alphabetical).toBe(true);
  });

  it("detects non-alphabetical ordering", () => {
    const result = detectImportOrderingDetailed(`
import react from "react";
import axios from "axios";
import lodash from "lodash";

import { foo } from "./foo";
`);
    expect(result.alphabetical).toBe(false);
  });

  it("detects node builtin separation", () => {
    const result = detectImportOrderingDetailed(`
import path from "node:path";
import fs from "node:fs";

import React from "react";
import lodash from "lodash";

import { helper } from "./helper";
`);
    expect(result.nodeBuiltinSeparated).toBe(true);
  });

  it("detects unseparated node builtins", () => {
    const result = detectImportOrderingDetailed(`
import path from "node:path";
import React from "react";
import lodash from "lodash";
import { helper } from "./helper";
`);
    expect(result.nodeBuiltinSeparated).toBe(false);
  });

  it("handles internal alias imports (@/ prefix)", () => {
    const result = detectImportOrderingDetailed(`
import React from "react";
import lodash from "lodash";

import { store } from "@/store";

import { helper } from "./helper";
`);
    expect(result.ordering).toBe("external-first, blank-line separated");
  });

  it("handles side-effect imports", () => {
    const result = detectImportOrderingDetailed(`
import "dotenv/config";
import React from "react";
import lodash from "lodash";
import { helper } from "./helper";
`);
    expect(result.ordering).toBe("external-first");
  });

  it("stops at non-import code", () => {
    const result = detectImportOrderingDetailed(`
import React from "react";
import lodash from "lodash";
import { helper } from "./helper";

const x = 1;
import { late } from "./late";
`);
    // Should only see 3 imports (stops at `const x`)
    expect(result.ordering).toBe("external-first");
  });

  it("handles mixed node builtins and external packages", () => {
    const result = detectImportOrderingDetailed(`
import path from "node:path";
import fs from "node:fs";
import React from "react";

import { helper } from "./helper";
`);
    expect(result.ordering).toBe("external-first, blank-line separated");
    expect(result.nodeBuiltinSeparated).toBe(false);
  });
});
