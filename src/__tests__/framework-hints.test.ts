import { describe, expect, it } from "vitest";
import { getFrameworkHints, getFrameworkHintsSection } from "../templates/framework-hints.js";
import type { DetectedContext, DetectedFramework } from "../types.js";

function makeCtx(frameworks: DetectedFramework[] = [], directories: string[] = []): DetectedContext {
  return {
    rootDir: "/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks,
    directories,
    dependencies: frameworks.map((f) => f.name.toLowerCase()),
    isGitRepo: true,
    totalSourceBytes: 0,
  };
}

describe("getFrameworkHints", () => {
  it("returns empty array when no frameworks detected", () => {
    const hints = getFrameworkHints(makeCtx());
    expect(hints).toEqual([]);
  });

  it("returns empty array for unrecognized framework", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "UnknownFramework" }]));
    expect(hints).toEqual([]);
  });

  // --- Next.js ---

  it("returns App Router hints for Next.js with app directory", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["app", "src"]));
    expect(hints.some((h) => h.includes("App Router"))).toBe(true);
    expect(hints.some((h) => h.includes("use client"))).toBe(true);
  });

  it("returns Pages Router hints for Next.js with pages directory", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["pages", "src"]));
    expect(hints.some((h) => h.includes("Pages Router"))).toBe(true);
    expect(hints.some((h) => h.includes("getServerSideProps"))).toBe(true);
  });

  it("returns hybrid hints for Next.js with both app and pages", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["app", "pages"]));
    expect(hints.some((h) => h.includes("Hybrid"))).toBe(true);
  });

  it("returns generic hints for Next.js with neither app nor pages", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["src"]));
    expect(hints.some((h) => h.includes("next/image"))).toBe(true);
  });

  // --- Express ---

  it("returns Express hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Express" }]));
    expect(hints.some((h) => h.includes("Middleware chain"))).toBe(true);
    expect(hints.some((h) => h.includes("express.Router()"))).toBe(true);
  });

  // --- Fastify ---

  it("returns Fastify hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Fastify" }]));
    expect(hints.some((h) => h.includes("Plugin architecture"))).toBe(true);
  });

  // --- Hono ---

  it("returns Hono hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Hono" }]));
    expect(hints.some((h) => h.includes("multiple runtimes"))).toBe(true);
  });

  // --- NestJS ---

  it("returns NestJS hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "NestJS" }]));
    expect(hints.some((h) => h.includes("Modules"))).toBe(true);
    expect(hints.some((h) => h.includes("@Injectable()"))).toBe(true);
  });

  // --- Expo / React Native ---

  it("returns Expo hints with React Native extras", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Expo" }, { name: "React Native" }]));
    expect(hints.some((h) => h.includes("expo-router"))).toBe(true);
    expect(hints.some((h) => h.includes("Reanimated"))).toBe(true);
  });

  it("returns Expo hints without Reanimated when RN is not present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Expo" }]));
    expect(hints.some((h) => h.includes("expo-router"))).toBe(true);
    expect(hints.some((h) => h.includes("Reanimated"))).toBe(false);
  });

  it("returns React Native hints when Expo is not present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React Native" }]));
    expect(hints.some((h) => h.includes("StyleSheet.create()"))).toBe(true);
  });

  it("skips React Native hints when Expo is also present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React Native" }, { name: "Expo" }]));
    // Should NOT have standalone RN hints (Expo covers them)
    expect(hints.some((h) => h.includes("StyleSheet.create()"))).toBe(false);
  });

  // --- React ---

  it("returns React hints when standalone", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React" }]));
    expect(hints.some((h) => h.includes("Functional components"))).toBe(true);
  });

  it("skips React hints when Next.js is present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React" }, { name: "Next.js" }], ["app"]));
    expect(hints.some((h) => h.includes("Functional components"))).toBe(false);
    // But Next.js hints should be present
    expect(hints.some((h) => h.includes("App Router"))).toBe(true);
  });

  // --- Vue ---

  it("returns Vue hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Vue" }]));
    expect(hints.some((h) => h.includes("Composition API"))).toBe(true);
  });

  // --- Nuxt ---

  it("returns Nuxt hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Nuxt" }]));
    expect(hints.some((h) => h.includes("Auto-imports"))).toBe(true);
  });

  // --- Svelte / SvelteKit ---

  it("returns Svelte hints when standalone", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Svelte" }]));
    expect(hints.some((h) => h.includes("Reactive declarations"))).toBe(true);
  });

  it("skips Svelte hints when SvelteKit is present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Svelte" }, { name: "SvelteKit" }]));
    expect(hints.some((h) => h.includes("Reactive declarations"))).toBe(false);
    expect(hints.some((h) => h.includes("File-based routing"))).toBe(true);
  });

  it("returns SvelteKit hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "SvelteKit" }]));
    expect(hints.some((h) => h.includes("+page.svelte"))).toBe(true);
  });

  // --- Angular ---

  it("returns Angular hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Angular" }]));
    expect(hints.some((h) => h.includes("@Component"))).toBe(true);
  });

  // --- Python frameworks ---

  it("returns Django hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Django" }]));
    expect(hints.some((h) => h.includes("models.py"))).toBe(true);
  });

  it("returns Flask hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Flask" }]));
    expect(hints.some((h) => h.includes("Blueprints"))).toBe(true);
  });

  it("returns FastAPI hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "FastAPI" }]));
    expect(hints.some((h) => h.includes("Depends()"))).toBe(true);
  });

  // --- ORMs ---

  it("returns Prisma hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Prisma" }]));
    expect(hints.some((h) => h.includes("schema.prisma"))).toBe(true);
  });

  it("returns Drizzle hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Drizzle" }]));
    expect(hints.some((h) => h.includes("drizzle-kit"))).toBe(true);
  });

  // --- Tailwind CSS ---

  it("returns Tailwind CSS hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Tailwind CSS" }]));
    expect(hints.some((h) => h.includes("Utility-first"))).toBe(true);
  });

  it("skips Tailwind CSS hints when NativeWind is present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Tailwind CSS" }, { name: "NativeWind" }]));
    expect(hints.some((h) => h.includes("Utility-first"))).toBe(false);
  });

  // --- Other ---

  it("returns Electron hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Electron" }]));
    expect(hints.some((h) => h.includes("Main process"))).toBe(true);
  });

  it("returns Remix hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Remix" }]));
    expect(hints.some((h) => h.includes("loader"))).toBe(true);
  });

  it("returns Astro hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Astro" }]));
    expect(hints.some((h) => h.includes("Zero JS by default"))).toBe(true);
  });

  it("returns Astro hints with framework integration info", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Astro" }, { name: "React" }]));
    expect(hints.some((h) => h.includes("React"))).toBe(true);
    expect(hints.some((h) => h.includes("client:load"))).toBe(true);
  });

  it("returns tRPC hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "tRPC" }]));
    expect(hints.some((h) => h.includes("appRouter"))).toBe(true);
  });

  it("returns Supabase hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Supabase" }]));
    expect(hints.some((h) => h.includes("Row Level Security"))).toBe(true);
  });

  // --- Multiple frameworks ---

  it("combines hints from multiple frameworks", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Express" }, { name: "Prisma" }]));
    expect(hints.some((h) => h.includes("Middleware chain"))).toBe(true);
    expect(hints.some((h) => h.includes("schema.prisma"))).toBe(true);
  });
});

describe("getFrameworkHintsSection", () => {
  it("returns empty string when no frameworks detected", () => {
    expect(getFrameworkHintsSection(makeCtx())).toBe("");
  });

  it("returns markdown section with header when hints exist", () => {
    const section = getFrameworkHintsSection(makeCtx([{ name: "Express" }]));
    expect(section).toContain("## Framework Conventions");
    expect(section).toContain("Middleware chain");
  });
});
