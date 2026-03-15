import type { DetectedContext } from "../../core/types.js";

/**
 * Get framework-specific conventions based on detected context.
 * Returns markdown lines (bullet points) to embed in context files.
 */
export function getFrameworkHints(ctx: DetectedContext): string[] {
  const hints: string[] = [];
  const frameworkNames = new Set(ctx.frameworks.map((f) => f.name));

  for (const gen of HINT_GENERATORS) {
    if (frameworkNames.has(gen.name)) {
      const lines = gen.getHints(ctx);
      if (lines.length > 0) hints.push(...lines);
    }
  }

  return hints;
}

/**
 * Get framework hints as a rendered markdown section.
 * Returns empty string if no hints are applicable.
 */
export function getFrameworkHintsSection(ctx: DetectedContext): string {
  const hints = getFrameworkHints(ctx);
  if (hints.length === 0) return "";

  const lines = ["## Framework Conventions", ""];
  for (const h of hints) {
    lines.push(h);
  }
  lines.push("");
  return lines.join("\n");
}

// --- Hint generators ---

interface HintGenerator {
  name: string;
  getHints: (ctx: DetectedContext) => string[];
}

const HINT_GENERATORS: HintGenerator[] = [
  {
    name: "Next.js",
    getHints: (ctx) => {
      const hints: string[] = [];
      const hasAppDir = ctx.directories.some((d) => d === "app" || d.startsWith("app/") || d === "src/app");
      const hasPagesDir = ctx.directories.some((d) => d === "pages" || d.startsWith("pages/") || d === "src/pages");

      if (hasAppDir && !hasPagesDir) {
        hints.push("### Next.js (App Router)");
        hints.push("");
        hints.push("- **App Router**: all routes in `app/` use React Server Components by default");
        hints.push(
          '- Add `"use client"` directive at the top of files that need browser APIs, hooks, or event handlers',
        );
        hints.push(
          "- `layout.tsx` wraps child routes; `page.tsx` is the route's UI; `loading.tsx` / `error.tsx` for boundaries",
        );
        hints.push(
          "- Data fetching: `async` server components with direct `fetch()` or DB calls (no `getServerSideProps`)",
        );
        hints.push("- Route handlers: `app/api/*/route.ts` with exported `GET`, `POST`, etc. functions");
        hints.push("- Middleware in `middleware.ts` at project root for auth, redirects, rewrites");
        hints.push("- Use `next/image` for optimized images, `next/font` for font loading");
      } else if (hasPagesDir && !hasAppDir) {
        hints.push("### Next.js (Pages Router)");
        hints.push("");
        hints.push("- **Pages Router**: routes in `pages/` directory");
        hints.push("- `getServerSideProps` for server-side data fetching, `getStaticProps` for static generation");
        hints.push("- `_app.tsx` for global layout/providers, `_document.tsx` for HTML customization");
        hints.push("- API routes in `pages/api/`");
      } else if (hasAppDir && hasPagesDir) {
        hints.push("### Next.js (Hybrid: App + Pages Router)");
        hints.push("");
        hints.push("- Both `app/` (App Router) and `pages/` (Pages Router) coexist. New routes should use App Router");
        hints.push(
          '- App Router components are server components by default; add `"use client"` for client components',
        );
        hints.push("- Pages Router uses `getServerSideProps` / `getStaticProps` for data fetching");
      } else {
        hints.push("### Next.js");
        hints.push("");
        hints.push("- Use `next/image` for optimized images, `next/font` for font loading");
        hints.push("- Middleware in `middleware.ts` at project root for auth, redirects, rewrites");
      }
      return hints;
    },
  },
  {
    name: "Express",
    getHints: () => [
      "### Express",
      "",
      "- Middleware chain: `app.use()` for global, router-level for scoped. Order matters.",
      "- Error handling: define a 4-arg middleware `(err, req, res, next)` at the end of the chain",
      "- Organize routes with `express.Router()` in separate files, mount with `app.use('/prefix', router)`",
      "- Validate request bodies/params at the route level (e.g. with zod, joi, or express-validator)",
      "- Use `async` handlers with try/catch or an async wrapper to avoid unhandled promise rejections",
      "- Set `res.status()` before `res.json()`. Don't rely on defaults for error responses",
    ],
  },
  {
    name: "Fastify",
    getHints: () => [
      "### Fastify",
      "",
      "- Plugin architecture: register plugins with `fastify.register()` for encapsulation",
      "- Schema-based validation: use JSON Schema for request/response validation (built-in)",
      "- Hooks: `onRequest`, `preHandler`, `onSend` etc. for request lifecycle",
      "- Use `fastify-plugin` for plugins that should not be encapsulated",
      "- Serialization: define response schemas for 2x faster JSON serialization",
    ],
  },
  {
    name: "Hono",
    getHints: () => [
      "### Hono",
      "",
      "- Middleware with `app.use()`. Compose with `c.next()` pattern",
      "- Validators: use `hono/validator` or `@hono/zod-validator` for type-safe request parsing",
      "- Context (`c`): `c.json()`, `c.text()`, `c.html()` for responses; `c.req` for request",
      "- Supports multiple runtimes (Node, Deno, Bun, Cloudflare Workers). Avoid Node-specific APIs",
    ],
  },
  {
    name: "NestJS",
    getHints: () => [
      "### NestJS",
      "",
      "- **Modules** organize the app into cohesive blocks; every feature gets a module",
      "- **Controllers** handle HTTP requests (decorators: `@Get()`, `@Post()`, etc.)",
      "- **Providers** (services) hold business logic, injected via constructor DI",
      "- **Guards** for auth (`@UseGuards()`), **Pipes** for validation (`@UsePipes()`)",
      "- **Interceptors** for response transformation, logging, caching",
      "- DTOs with `class-validator` decorators for request validation",
      "- Use `@Injectable()` on all services/providers",
    ],
  },
  {
    name: "Expo",
    getHints: (ctx) => {
      const hasRN = ctx.frameworks.some((f) => f.name === "React Native");
      const hints = ["### Expo / React Native", ""];
      hints.push("- **expo-router** for file-based routing (if using); Stack, Tabs, Drawer navigators");
      hints.push("- Expo Go has limited native module support. Some packages require a dev build (`npx expo run:ios`)");
      hints.push("- Use `expo-constants`, `expo-device` etc. instead of raw RN APIs when available");
      hints.push("- Platform-specific files: `*.ios.tsx` / `*.android.tsx` or `Platform.select()`");
      if (hasRN) {
        hints.push('- **Reanimated**: worklet functions need the `"worklet"` directive on the first line');
        hints.push(
          "- Avoid `FadeIn`/`FadeOut` entering/exiting animations on conditionally rendered components. They cause flashes",
        );
      }
      return hints;
    },
  },
  {
    name: "React Native",
    getHints: (ctx) => {
      // Only emit if Expo is NOT also detected (Expo handler covers RN+Expo)
      if (ctx.frameworks.some((f) => f.name === "Expo")) return [];
      return [
        "### React Native",
        "",
        "- Use `StyleSheet.create()` for styles. Avoid inline style objects in render",
        "- Platform-specific: `*.ios.tsx` / `*.android.tsx` or `Platform.select()`",
        '- **Reanimated**: worklet functions need the `"worklet"` directive',
        "- Navigation: React Navigation with Stack/Tab/Drawer navigators",
        "- Test with both iOS and Android. Layout behavior differs",
      ];
    },
  },
  {
    name: "React",
    getHints: (ctx) => {
      // Skip if Next.js, Expo, or React Native is detected (they have their own hints)
      const skip = ["Next.js", "Expo", "React Native"];
      if (ctx.frameworks.some((f) => skip.includes(f.name))) return [];
      return [
        "### React",
        "",
        "- Functional components with hooks (no class components)",
        "- Use `React.memo()` for expensive renders, `useMemo`/`useCallback` for referential stability",
        "- Lift state up or use context for shared state; avoid prop drilling beyond 2-3 levels",
        "- Prefer controlled components for forms",
        "- Use `Suspense` boundaries with `lazy()` for code splitting",
      ];
    },
  },
  {
    name: "Vue",
    getHints: () => [
      "### Vue",
      "",
      "- Composition API with `<script setup>` for new components",
      "- Reactive state: `ref()` for primitives, `reactive()` for objects",
      "- `computed()` for derived state, `watch()` / `watchEffect()` for side effects",
      "- Props: define with `defineProps<T>()`, emits with `defineEmits<T>()`",
      "- Use `provide` / `inject` for deep dependency injection",
    ],
  },
  {
    name: "Nuxt",
    getHints: () => [
      "### Nuxt",
      "",
      "- Auto-imports: components, composables, and utils are auto-imported (no manual import needed)",
      "- File-based routing in `pages/`. Dynamic params with `[id].vue` syntax",
      "- Data fetching: `useFetch()` / `useAsyncData()`. They handle SSR hydration automatically",
      "- Server routes in `server/api/`, auto-registered, use `defineEventHandler()`",
      "- Middleware in `middleware/`. `defineNuxtRouteMiddleware()` for route guards",
      "- State: `useState()` for SSR-safe shared state, Pinia for complex stores",
    ],
  },
  {
    name: "Svelte",
    getHints: (ctx) => {
      if (ctx.frameworks.some((f) => f.name === "SvelteKit")) return [];
      return [
        "### Svelte",
        "",
        "- Reactive declarations with `$:` for derived state",
        "- Props: `export let propName` in component script",
        "- Stores: `writable()`, `readable()`, `derived()`. Auto-subscribe with `$store` syntax",
        "- Use `{#if}`, `{#each}`, `{#await}` blocks for conditional/list/async rendering",
      ];
    },
  },
  {
    name: "SvelteKit",
    getHints: () => [
      "### SvelteKit",
      "",
      "- File-based routing in `src/routes/`: `+page.svelte`, `+layout.svelte`, `+server.ts`",
      "- `+page.ts` (universal) or `+page.server.ts` (server-only) for `load` functions",
      "- Form actions in `+page.server.ts` with `actions` export for progressive enhancement",
      "- Hooks in `src/hooks.server.ts` for auth, session, error handling",
      "- Use `$app/stores` for page, navigating, updated stores",
    ],
  },
  {
    name: "Angular",
    getHints: () => [
      "### Angular",
      "",
      "- Components, services, pipes, directives all use decorators (`@Component`, `@Injectable`, etc.)",
      "- Dependency injection: provide services in module or component `providers` array",
      "- RxJS Observables for async data. Use `async` pipe in templates, unsubscribe on destroy",
      "- Lazy-load feature modules with `loadChildren` in routes",
      "- Use Angular CLI (`ng generate`) for scaffolding",
    ],
  },
  {
    name: "Django",
    getHints: () => [
      "### Django",
      "",
      "- Apps structure: each feature is a Django app with `models.py`, `views.py`, `urls.py`, `admin.py`",
      "- Models: define in `models.py`, create migrations with `python manage.py makemigrations`",
      "- Views: function-based (FBV) or class-based (CBV). CBV for CRUD, FBV for custom logic",
      "- URL routing in `urls.py` using `path()` and `include()` for app-level URLs",
      "- Templates in `templates/`. Use template inheritance with `{% extends %}` and `{% block %}`",
      "- Management commands in `management/commands/` for custom CLI tasks",
      "- Settings: use `django-environ` or `python-decouple` for environment-based config",
    ],
  },
  {
    name: "Flask",
    getHints: () => [
      "### Flask",
      "",
      "- Blueprints for modular route organization. Register with `app.register_blueprint()`",
      "- Use application factory pattern (`create_app()`) for testing and config flexibility",
      "- Error handlers with `@app.errorhandler(404)` etc.",
      "- Use Flask-SQLAlchemy for ORM, Flask-Migrate for database migrations",
      "- Request context: `request`, `g`, `session` globals, available inside request handlers",
    ],
  },
  {
    name: "FastAPI",
    getHints: () => [
      "### FastAPI",
      "",
      "- **Dependency injection**: use `Depends()` for shared logic (auth, DB sessions, validation)",
      "- **Pydantic models** for request/response schemas with automatic validation and OpenAPI docs",
      "- Async endpoints by default (`async def`); use sync `def` only for blocking I/O with threadpool",
      "- Routers: `APIRouter()` for modular route organization, mount with `app.include_router()`",
      '- Middleware with `@app.middleware("http")` or Starlette middleware classes',
      "- Background tasks with `BackgroundTasks` parameter for fire-and-forget work",
      "- Auto-generated docs at `/docs` (Swagger) and `/redoc`",
    ],
  },
  {
    name: "Prisma",
    getHints: () => [
      "### Prisma",
      "",
      "- Schema in `prisma/schema.prisma`. Run `npx prisma generate` after changes",
      "- Migrations: `npx prisma migrate dev` for development, `npx prisma migrate deploy` for production",
      "- Use `prisma.$transaction()` for atomic operations",
      "- Relation queries: use `include` for eager loading, `select` for field filtering",
    ],
  },
  {
    name: "Drizzle",
    getHints: () => [
      "### Drizzle",
      "",
      "- Schema defined in TypeScript. Type-safe queries with no code generation step",
      "- Migrations: `drizzle-kit generate` then `drizzle-kit migrate`",
      "- Use `db.select()`, `db.insert()`, `db.update()`, `db.delete()` for queries",
      "- Relations: define with `relations()` helper for type-safe joins",
    ],
  },
  {
    name: "Tailwind CSS",
    getHints: (ctx) => {
      // Skip if NativeWind is detected (Expo/RN handles it)
      if (ctx.frameworks.some((f) => f.name === "NativeWind")) return [];
      return [
        "### Tailwind CSS",
        "",
        "- Utility-first: compose styles with `className`. Avoid custom CSS unless truly needed",
        "- Use `@apply` sparingly in CSS modules for repeated patterns",
        "- Responsive: mobile-first with `sm:`, `md:`, `lg:` breakpoint prefixes",
        "- Dark mode: `dark:` variant (class or media strategy per `tailwind.config`)",
        "- Extract reusable component classes into shared components, not `@apply` blocks",
      ];
    },
  },
  {
    name: "Electron",
    getHints: () => [
      "### Electron",
      "",
      "- **Main process** (Node.js) and **renderer process** (Chromium). Communicate via IPC",
      "- Use `contextBridge` + `preload.js` to expose safe APIs to renderer (no `nodeIntegration`)",
      "- `ipcMain.handle()` / `ipcRenderer.invoke()` for async request-response patterns",
      "- Package with `electron-builder` or `electron-forge`",
    ],
  },
  {
    name: "Remix",
    getHints: () => [
      "### Remix",
      "",
      "- File-based routing in `app/routes/`. Nested routes via directory structure or dot-delimited filenames",
      "- `loader` functions for GET data fetching, `action` functions for mutations (POST/PUT/DELETE)",
      "- Use `<Form>` component for progressive enhancement (works without JS)",
      "- `ErrorBoundary` export per route for granular error handling",
      "- `defer()` with `<Await>` for streaming deferred data",
      "- Nested layouts via `<Outlet />`; each route segment can have its own loader/action/boundary",
    ],
  },
  {
    name: "Astro",
    getHints: (ctx) => {
      const hints = [
        "### Astro",
        "",
        "- `.astro` components: frontmatter (server JS) in `---` fences, HTML template below",
        "- **Zero JS by default**: components ship no client-side JavaScript unless opted in",
        "- `client:*` directives for hydration: `client:load`, `client:idle`, `client:visible`, `client:media`",
        "- Content Collections in `src/content/` with schema validation via `defineCollection()`",
        "- Island architecture: mix framework components (React, Vue, Svelte) in the same page",
      ];
      const hasReact = ctx.frameworks.some((f) => f.name === "React");
      const hasVue = ctx.frameworks.some((f) => f.name === "Vue");
      const hasSvelte = ctx.frameworks.some((f) => f.name === "Svelte");
      const integrations = [hasReact && "React", hasVue && "Vue", hasSvelte && "Svelte"].filter(Boolean);
      if (integrations.length > 0) {
        hints.push(
          `- Framework integrations detected: ${integrations.join(", ")}. Use \`client:load\` to hydrate these components`,
        );
      }
      return hints;
    },
  },
  {
    name: "tRPC",
    getHints: () => [
      "### tRPC",
      "",
      "- Define procedures on `appRouter` using `router()` and `procedure` builders",
      "- Input validation with Zod schemas: `procedure.input(z.object({ ... })).query/mutation(...)`",
      "- Middleware via `.use()` for auth, logging, rate limiting",
      "- Export `AppRouter` type from the server for client-side type inference",
      "- Client uses React Query hooks (`trpc.useQuery`, `trpc.useMutation`) for data fetching",
    ],
  },
  {
    name: "Supabase",
    getHints: () => [
      "### Supabase",
      "",
      "- Create client with `createClient(url, anonKey)`. Use server-side client for privileged operations",
      "- Auth: `supabase.auth.signInWithPassword()`, `signUp()`, `signOut()`. Session managed automatically",
      "- Database queries use PostgREST syntax: `supabase.from('table').select().eq('col', val)`",
      "- **Row Level Security (RLS)**: always enable on tables; write policies for access control",
      "- Realtime subscriptions: `supabase.channel('name').on('postgres_changes', ...).subscribe()`",
    ],
  },
];
