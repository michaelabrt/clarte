import type { DetectedFramework } from "../types.js";

/** Framework detection rules: dependency name -> framework info */
export const FRAMEWORK_MAP: Record<string, string> = {
  expo: "Expo",
  "react-native": "React Native",
  next: "Next.js",
  react: "React",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  angular: "Angular",
  "@angular/core": "Angular",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  "nestjs/core": "NestJS",
  "@nestjs/core": "NestJS",
  electron: "Electron",
  tauri: "Tauri",
  zustand: "Zustand",
  redux: "Redux",
  "@reduxjs/toolkit": "Redux Toolkit",
  pinia: "Pinia",
  mobx: "MobX",
  jotai: "Jotai",
  recoil: "Recoil",
  jest: "Jest",
  vitest: "Vitest",
  playwright: "Playwright",
  cypress: "Cypress",
  tailwindcss: "Tailwind CSS",
  nativewind: "NativeWind",
  "styled-components": "styled-components",
  "@emotion/react": "Emotion",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  drizzle: "Drizzle",
  "drizzle-orm": "Drizzle",
  typeorm: "TypeORM",
  mongoose: "Mongoose",
  "@remix-run/node": "Remix",
  "@remix-run/react": "Remix",
  astro: "Astro",
  "@trpc/server": "tRPC",
  "@trpc/client": "tRPC",
  "@supabase/supabase-js": "Supabase",
};

/** Python framework detection */
export const PYTHON_FRAMEWORK_MAP: Record<string, string> = {
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  starlette: "Starlette",
  sqlalchemy: "SQLAlchemy",
  pydantic: "Pydantic",
  pytest: "pytest",
  celery: "Celery",
};

function buildReverseFrameworkMap(): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [dep, name] of Object.entries(FRAMEWORK_MAP)) {
    const deps = reverse.get(name) ?? [];
    deps.push(dep);
    reverse.set(name, deps);
  }
  return reverse;
}

/**
 * Enrich detected frameworks with actual import counts from the import graph.
 */
export function enrichFrameworksWithUsage(
  frameworks: DetectedFramework[],
  externalImportCounts: Map<string, number>,
): DetectedFramework[] {
  const reverseMap = buildReverseFrameworkMap();

  return frameworks.map((fw) => {
    const depNames = reverseMap.get(fw.name) ?? [];
    let totalCount = 0;
    for (const dep of depNames) {
      totalCount += externalImportCounts.get(dep) ?? 0;
    }
    return { ...fw, importCount: totalCount };
  });
}

/**
 * Extract Maven version from pom.xml content.
 */
export function extractMavenVersion(pomXml: string): string | undefined {
  const withoutParent = pomXml.replace(/<parent>[\s\S]*?<\/parent>/, "");
  const projectMatch = withoutParent.match(/<version>([^<]+)<\/version>/);
  if (projectMatch) return projectMatch[1];

  const parentMatch = pomXml.match(/<parent>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/);
  return parentMatch?.[1] ?? undefined;
}
