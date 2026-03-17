import { describe, expect, it } from "vitest";
import { getFrameworkHints, getFrameworkHintsSection } from "../steer/context/framework-hints";
import type { DetectedContext, DetectedFramework } from "../core/types";

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
    expect(hints).toContain("### Next.js (App Router)");
    expect(hints).toContain(
      '- Add `"use client"` directive at the top of files that need browser APIs, hooks, or event handlers',
    );
  });

  it("returns Pages Router hints for Next.js with pages directory", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["pages", "src"]));
    expect(hints).toContain("### Next.js (Pages Router)");
    expect(hints).toContain(
      "- `getServerSideProps` for server-side data fetching, `getStaticProps` for static generation",
    );
  });

  it("returns hybrid hints for Next.js with both app and pages", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["app", "pages"]));
    expect(hints).toContain("### Next.js (Hybrid: App + Pages Router)");
  });

  it("returns generic hints for Next.js with neither app nor pages", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["src"]));
    expect(hints).toContain("### Next.js");
    expect(hints).toContain("- Use `next/image` for optimized images, `next/font` for font loading");
  });

  it("detects src/app as App Router directory", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["src/app"]));
    expect(hints).toContain("### Next.js (App Router)");
  });

  it("detects src/pages as Pages Router directory", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Next.js" }], ["src/pages"]));
    expect(hints).toContain("### Next.js (Pages Router)");
  });

  // --- Express ---

  it("returns Express hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Express" }]));
    expect(hints).toContain("### Express");
    expect(hints).toContain("- Middleware chain: `app.use()` for global, router-level for scoped. Order matters.");
    expect(hints).toContain(
      "- Organize routes with `express.Router()` in separate files, mount with `app.use('/prefix', router)`",
    );
  });

  // --- Fastify ---

  it("returns Fastify hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Fastify" }]));
    expect(hints).toContain("### Fastify");
    expect(hints).toContain("- Plugin architecture: register plugins with `fastify.register()` for encapsulation");
  });

  // --- Hono ---

  it("returns Hono hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Hono" }]));
    expect(hints).toContain("### Hono");
    expect(hints).toContain(
      "- Supports multiple runtimes (Node, Deno, Bun, Cloudflare Workers). Avoid Node-specific APIs",
    );
  });

  // --- NestJS ---

  it("returns NestJS hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "NestJS" }]));
    expect(hints).toContain("### NestJS");
    expect(hints).toContain("- **Modules** organize the app into cohesive blocks; every feature gets a module");
    expect(hints).toContain("- Use `@Injectable()` on all services/providers");
  });

  // --- Expo / React Native ---

  it("returns Expo hints with React Native extras", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Expo" }, { name: "React Native" }]));
    expect(hints).toContain("### Expo / React Native");
    expect(hints).toContain("- **expo-router** for file-based routing (if using); Stack, Tabs, Drawer navigators");
    expect(hints).toContain('- **Reanimated**: worklet functions need the `"worklet"` directive on the first line');
  });

  it("returns Expo hints without Reanimated when RN is not present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Expo" }]));
    expect(hints).toContain("- **expo-router** for file-based routing (if using); Stack, Tabs, Drawer navigators");
    expect(hints).not.toContain('- **Reanimated**: worklet functions need the `"worklet"` directive on the first line');
  });

  it("returns React Native hints when Expo is not present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React Native" }]));
    expect(hints).toContain("### React Native");
    expect(hints).toContain("- Use `StyleSheet.create()` for styles. Avoid inline style objects in render");
  });

  it("skips React Native hints when Expo is also present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React Native" }, { name: "Expo" }]));
    // Should NOT have standalone RN hints (Expo covers them)
    expect(hints).not.toContain("- Use `StyleSheet.create()` for styles. Avoid inline style objects in render");
  });

  // --- React ---

  it("returns React hints when standalone", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React" }]));
    expect(hints).toContain("### React");
    expect(hints).toContain("- Functional components with hooks (no class components)");
  });

  it("skips React hints when Next.js is present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "React" }, { name: "Next.js" }], ["app"]));
    expect(hints).not.toContain("- Functional components with hooks (no class components)");
    // But Next.js hints should be present
    expect(hints).toContain("### Next.js (App Router)");
  });

  // --- Vue ---

  it("returns Vue hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Vue" }]));
    expect(hints).toContain("### Vue");
    expect(hints).toContain("- Composition API with `<script setup>` for new components");
  });

  // --- Nuxt ---

  it("returns Nuxt hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Nuxt" }]));
    expect(hints).toContain("### Nuxt");
    expect(hints).toContain(
      "- Auto-imports: components, composables, and utils are auto-imported (no manual import needed)",
    );
  });

  // --- Svelte / SvelteKit ---

  it("returns Svelte hints when standalone", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Svelte" }]));
    expect(hints).toContain("### Svelte");
    expect(hints).toContain("- Reactive declarations with `$:` for derived state");
  });

  it("skips Svelte hints when SvelteKit is present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Svelte" }, { name: "SvelteKit" }]));
    expect(hints).not.toContain("- Reactive declarations with `$:` for derived state");
    expect(hints).toContain("- File-based routing in `src/routes/`: `+page.svelte`, `+layout.svelte`, `+server.ts`");
  });

  it("returns SvelteKit hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "SvelteKit" }]));
    expect(hints).toContain("### SvelteKit");
    expect(hints).toContain("- File-based routing in `src/routes/`: `+page.svelte`, `+layout.svelte`, `+server.ts`");
  });

  // --- Angular ---

  it("returns Angular hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Angular" }]));
    expect(hints).toContain("### Angular");
    expect(hints).toContain(
      "- Components, services, pipes, directives all use decorators (`@Component`, `@Injectable`, etc.)",
    );
  });

  // --- Python frameworks ---

  it("returns Django hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Django" }]));
    expect(hints).toContain("### Django");
    expect(hints).toContain(
      "- Apps structure: each feature is a Django app with `models.py`, `views.py`, `urls.py`, `admin.py`",
    );
  });

  it("returns Flask hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Flask" }]));
    expect(hints).toContain("### Flask");
    expect(hints).toContain("- Blueprints for modular route organization. Register with `app.register_blueprint()`");
  });

  it("returns FastAPI hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "FastAPI" }]));
    expect(hints).toContain("### FastAPI");
    expect(hints).toContain(
      "- **Dependency injection**: use `Depends()` for shared logic (auth, DB sessions, validation)",
    );
  });

  // --- ORMs ---

  it("returns Prisma hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Prisma" }]));
    expect(hints).toContain("### Prisma");
    expect(hints).toContain("- Schema in `prisma/schema.prisma`. Run `npx prisma generate` after changes");
  });

  it("returns Drizzle hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Drizzle" }]));
    expect(hints).toContain("### Drizzle");
    expect(hints).toContain("- Migrations: `drizzle-kit generate` then `drizzle-kit migrate`");
  });

  // --- Tailwind CSS ---

  it("returns Tailwind CSS hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Tailwind CSS" }]));
    expect(hints).toContain("### Tailwind CSS");
    expect(hints).toContain("- Utility-first: compose styles with `className`. Avoid custom CSS unless truly needed");
  });

  it("skips Tailwind CSS hints when NativeWind is present", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Tailwind CSS" }, { name: "NativeWind" }]));
    expect(hints).not.toContain(
      "- Utility-first: compose styles with `className`. Avoid custom CSS unless truly needed",
    );
  });

  // --- Other ---

  it("returns Electron hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Electron" }]));
    expect(hints).toContain("### Electron");
    expect(hints).toContain("- **Main process** (Node.js) and **renderer process** (Chromium). Communicate via IPC");
  });

  it("returns Remix hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Remix" }]));
    expect(hints).toContain("### Remix");
    expect(hints).toContain(
      "- `loader` functions for GET data fetching, `action` functions for mutations (POST/PUT/DELETE)",
    );
  });

  it("returns Astro hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Astro" }]));
    expect(hints).toContain("### Astro");
    expect(hints).toContain("- **Zero JS by default**: components ship no client-side JavaScript unless opted in");
  });

  it("returns Astro hints with framework integration info", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Astro" }, { name: "React" }]));
    expect(hints).toContain("- Framework integrations detected: React. Use `client:load` to hydrate these components");
  });

  it("returns tRPC hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "tRPC" }]));
    expect(hints).toContain("### tRPC");
    expect(hints).toContain("- Define procedures on `appRouter` using `router()` and `procedure` builders");
  });

  it("returns Supabase hints", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Supabase" }]));
    expect(hints).toContain("### Supabase");
    expect(hints).toContain(
      "- **Row Level Security (RLS)**: always enable on tables; write policies for access control",
    );
  });

  // --- Multiple frameworks ---

  it("combines hints from multiple frameworks", () => {
    const hints = getFrameworkHints(makeCtx([{ name: "Express" }, { name: "Prisma" }]));
    expect(hints).toContain("- Middleware chain: `app.use()` for global, router-level for scoped. Order matters.");
    expect(hints).toContain("- Schema in `prisma/schema.prisma`. Run `npx prisma generate` after changes");
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
