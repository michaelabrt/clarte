/**
 * Realistic project fixtures for agent performance benchmarking.
 *
 * These fixtures model real-world project architectures at higher fidelity
 * than the core eval fixtures. Each has comprehensive ground-truth
 * expectations covering all algorithm outputs.
 */

import { edge } from "./helpers.js";
import type { EvalFixture } from "./fixtures.js";

// ── Fixture: React Fullstack App ──────────────────────────────────────

/**
 * Models a Next.js-style React fullstack project:
 *   types/ -> hooks/ -> components/ -> pages/
 *   types/ -> stores/ -> hooks/
 *   lib/ (api, db, auth) shared across layers
 *
 * 31 files. Clean architecture with one intentional cycle
 * (auth hook <-> auth store for refresh token flow).
 * app.tsx serves as the entry point importing all pages.
 */
export const reactFullstack: EvalFixture = {
  name: "react-fullstack",
  description: "Next.js-style fullstack app with types, hooks, stores, components, and pages",
  graph: {
    files: [
      // Types layer (foundation)
      "types/user.ts",
      "types/product.ts",
      "types/order.ts",
      "types/index.ts",
      // Lib layer (shared utilities)
      "lib/api-client.ts",
      "lib/db.ts",
      "lib/auth.ts",
      "lib/validation.ts",
      // Stores layer
      "stores/user-store.ts",
      "stores/cart-store.ts",
      "stores/auth-store.ts",
      // Hooks layer
      "hooks/use-user.ts",
      "hooks/use-cart.ts",
      "hooks/use-auth.ts",
      "hooks/use-products.ts",
      // Components layer
      "components/header.tsx",
      "components/product-card.tsx",
      "components/cart-drawer.tsx",
      "components/user-avatar.tsx",
      "components/auth-guard.tsx",
      // Pages layer (entry points)
      "pages/home.tsx",
      "pages/product/[id].tsx",
      "pages/cart.tsx",
      "pages/profile.tsx",
      "pages/login.tsx",
      // API routes
      "api/users.ts",
      "api/products.ts",
      "api/orders.ts",
      "api/auth.ts",
      // Config (cross-cutting)
      "config/env.ts",
      // App entry point
      "app.tsx",
    ],
    edges: [
      // types/index.ts re-exports
      edge("types/index.ts", "types/user.ts", ["User"], true),
      edge("types/index.ts", "types/product.ts", ["Product"], true),
      edge("types/index.ts", "types/order.ts", ["Order"], true),

      // lib/ imports types
      edge("lib/api-client.ts", "config/env.ts", ["API_URL"]),
      edge("lib/db.ts", "config/env.ts", ["DB_URL"]),
      edge("lib/auth.ts", "types/user.ts", ["User"]),
      edge("lib/auth.ts", "config/env.ts", ["JWT_SECRET"]),
      edge("lib/validation.ts", "types/user.ts", ["User"]),
      edge("lib/validation.ts", "types/product.ts", ["Product"]),
      edge("lib/validation.ts", "types/order.ts", ["Order"]),

      // stores/ import types and lib
      edge("stores/user-store.ts", "types/user.ts", ["User"]),
      edge("stores/user-store.ts", "lib/api-client.ts", ["get", "put"]),
      edge("stores/cart-store.ts", "types/product.ts", ["Product"]),
      edge("stores/cart-store.ts", "types/order.ts", ["CartItem"]),
      edge("stores/cart-store.ts", "lib/api-client.ts", ["post"]),
      edge("stores/auth-store.ts", "types/user.ts", ["User"]),
      edge("stores/auth-store.ts", "lib/auth.ts", ["refreshToken"]),
      edge("stores/auth-store.ts", "lib/api-client.ts", ["post"]),

      // hooks/ import stores and types
      edge("hooks/use-user.ts", "stores/user-store.ts", ["useUserStore"]),
      edge("hooks/use-user.ts", "types/user.ts", ["User"]),
      edge("hooks/use-cart.ts", "stores/cart-store.ts", ["useCartStore"]),
      edge("hooks/use-cart.ts", "types/product.ts", ["Product"]),
      edge("hooks/use-auth.ts", "stores/auth-store.ts", ["useAuthStore"]),
      edge("hooks/use-auth.ts", "types/user.ts", ["User"]),
      edge("hooks/use-auth.ts", "lib/auth.ts", ["checkAuth"]),
      edge("hooks/use-products.ts", "types/product.ts", ["Product"]),
      edge("hooks/use-products.ts", "lib/api-client.ts", ["get"]),

      // Intentional cycle: auth-store -> auth hook (refresh) and auth hook -> auth-store
      edge("stores/auth-store.ts", "hooks/use-auth.ts", ["onTokenExpired"]),

      // components/ import hooks and types
      edge("components/header.tsx", "hooks/use-auth.ts", ["useAuth"]),
      edge("components/header.tsx", "hooks/use-cart.ts", ["useCart"]),
      edge("components/header.tsx", "components/user-avatar.tsx", ["UserAvatar"]),
      edge("components/user-avatar.tsx", "hooks/use-user.ts", ["useUser"]),
      edge("components/user-avatar.tsx", "types/user.ts", ["User"]),
      edge("components/product-card.tsx", "types/product.ts", ["Product"]),
      edge("components/product-card.tsx", "hooks/use-cart.ts", ["useCart"]),
      edge("components/cart-drawer.tsx", "hooks/use-cart.ts", ["useCart"]),
      edge("components/cart-drawer.tsx", "types/order.ts", ["CartItem"]),
      edge("components/auth-guard.tsx", "hooks/use-auth.ts", ["useAuth"]),

      // pages/ import components, hooks, types, and config
      // Each page needs 5+ outgoing deps for instability > 0.8 (with fanIn=1 from app.tsx)
      edge("pages/home.tsx", "components/header.tsx", ["Header"]),
      edge("pages/home.tsx", "components/product-card.tsx", ["ProductCard"]),
      edge("pages/home.tsx", "hooks/use-products.ts", ["useProducts"]),
      edge("pages/home.tsx", "types/product.ts", ["Product"]),
      edge("pages/home.tsx", "config/env.ts", ["SITE_TITLE"]),
      edge("pages/product/[id].tsx", "components/header.tsx", ["Header"]),
      edge("pages/product/[id].tsx", "components/product-card.tsx", ["ProductCard"]),
      edge("pages/product/[id].tsx", "hooks/use-products.ts", ["useProducts"]),
      edge("pages/product/[id].tsx", "hooks/use-cart.ts", ["useCart"]),
      edge("pages/product/[id].tsx", "types/product.ts", ["Product"]),
      edge("pages/cart.tsx", "components/header.tsx", ["Header"]),
      edge("pages/cart.tsx", "components/cart-drawer.tsx", ["CartDrawer"]),
      edge("pages/cart.tsx", "components/auth-guard.tsx", ["AuthGuard"]),
      edge("pages/cart.tsx", "hooks/use-cart.ts", ["useCart"]),
      edge("pages/cart.tsx", "types/order.ts", ["Order"]),
      edge("pages/profile.tsx", "components/header.tsx", ["Header"]),
      edge("pages/profile.tsx", "components/user-avatar.tsx", ["UserAvatar"]),
      edge("pages/profile.tsx", "hooks/use-user.ts", ["useUser"]),
      edge("pages/profile.tsx", "components/auth-guard.tsx", ["AuthGuard"]),
      edge("pages/profile.tsx", "types/user.ts", ["User"]),
      edge("pages/login.tsx", "hooks/use-auth.ts", ["useAuth"]),
      edge("pages/login.tsx", "lib/validation.ts", ["validateEmail"]),
      edge("pages/login.tsx", "components/auth-guard.tsx", ["AuthGuard"]),
      edge("pages/login.tsx", "types/user.ts", ["User"]),
      edge("pages/login.tsx", "config/env.ts", ["AUTH_URL"]),

      // app.tsx entry point imports all pages (gives each page fanIn=1)
      edge("app.tsx", "pages/home.tsx", ["HomePage"]),
      edge("app.tsx", "pages/product/[id].tsx", ["ProductPage"]),
      edge("app.tsx", "pages/cart.tsx", ["CartPage"]),
      edge("app.tsx", "pages/profile.tsx", ["ProfilePage"]),
      edge("app.tsx", "pages/login.tsx", ["LoginPage"]),

      // API routes import lib and types
      edge("api/users.ts", "lib/db.ts", ["query"]),
      edge("api/users.ts", "types/user.ts", ["User"]),
      edge("api/users.ts", "lib/validation.ts", ["validateUser"]),
      edge("api/users.ts", "lib/auth.ts", ["requireAuth"]),
      edge("api/products.ts", "lib/db.ts", ["query"]),
      edge("api/products.ts", "types/product.ts", ["Product"]),
      edge("api/orders.ts", "lib/db.ts", ["query"]),
      edge("api/orders.ts", "types/order.ts", ["Order"]),
      edge("api/orders.ts", "lib/auth.ts", ["requireAuth"]),
      edge("api/auth.ts", "lib/auth.ts", ["signToken", "verifyToken"]),
      edge("api/auth.ts", "lib/db.ts", ["query"]),
      edge("api/auth.ts", "types/user.ts", ["User"]),
    ],
  },
  expectations: {
    // types/user.ts is the most imported type file (used by auth, stores, hooks, components, api)
    topAuthorityFiles: ["types/user.ts", "types/product.ts", "lib/api-client.ts"],
    // Pages have many outgoing deps and only 1 incoming (from app.tsx): instability > 0.8
    highInstabilityFiles: [
      "pages/home.tsx",
      "pages/product/[id].tsx",
      "pages/cart.tsx",
      "pages/profile.tsx",
      "pages/login.tsx",
    ],
    // types/user.ts is foundational; should NOT be unstable
    stableFiles: ["types/user.ts", "types/product.ts", "config/env.ts"],
    // Should detect types, hooks, stores, components, pages layers
    expectedLayerOrder: ["types", "hooks", "stores", "components"],
    // auth-store <-> use-auth cycle
    knownCycles: [["stores/auth-store.ts", "hooks/use-auth.ts"]],
    // Well-connected graph has no articulation points
    knownChokepoints: [],
    minCommunities: 2,
    maxCommunities: 10,
    // config/env.ts is a pure sink (no outgoing edges); directed betweenness = 0
    zeroBetweennessFiles: ["config/env.ts"],
  },
};

// ── Fixture: Python Backend Service ───────────────────────────────────

/**
 * Models a FastAPI-style Python backend:
 *   models/ -> schemas/ -> services/ -> routes/
 *   core/ (config, security, database) shared across layers
 *   tasks/ (background workers) import services
 *
 * 25 files. Clean layered architecture, no cycles.
 */
export const pythonBackend: EvalFixture = {
  name: "python-backend",
  description: "FastAPI-style Python backend with models, schemas, services, routes, and background tasks",
  graph: {
    files: [
      // Core layer (cross-cutting foundation)
      "core/config.py",
      "core/database.py",
      "core/security.py",
      "core/exceptions.py",
      // Models layer (ORM)
      "models/user.py",
      "models/product.py",
      "models/order.py",
      "models/base.py",
      // Schemas layer (Pydantic)
      "schemas/user.py",
      "schemas/product.py",
      "schemas/order.py",
      // Services layer (business logic)
      "services/user_service.py",
      "services/product_service.py",
      "services/order_service.py",
      "services/email_service.py",
      // Routes layer (API endpoints)
      "routes/users.py",
      "routes/products.py",
      "routes/orders.py",
      "routes/auth.py",
      // Tasks layer (background workers)
      "tasks/send_email.py",
      "tasks/process_order.py",
      "tasks/cleanup.py",
      // Entry points
      "main.py",
      "deps.py",
      "middleware.py",
    ],
    edges: [
      // core/ internal deps
      edge("core/database.py", "core/config.py", ["settings"]),
      edge("core/security.py", "core/config.py", ["settings"]),

      // models/ import core
      edge("models/base.py", "core/database.py", ["Base", "engine"]),
      edge("models/user.py", "models/base.py", ["Base"]),
      edge("models/user.py", "core/database.py", ["Column", "String"]),
      edge("models/product.py", "models/base.py", ["Base"]),
      edge("models/product.py", "core/database.py", ["Column"]),
      edge("models/order.py", "models/base.py", ["Base"]),
      edge("models/order.py", "models/user.py", ["User"], true),
      edge("models/order.py", "models/product.py", ["Product"], true),
      edge("models/order.py", "core/database.py", ["Column", "ForeignKey"]),

      // schemas/ import models (type-only for validation)
      edge("schemas/user.py", "models/user.py", ["User"], true),
      edge("schemas/product.py", "models/product.py", ["Product"], true),
      edge("schemas/order.py", "models/order.py", ["Order"], true),
      edge("schemas/order.py", "schemas/product.py", ["ProductSchema"], true),

      // services/ import models, schemas, core
      edge("services/user_service.py", "models/user.py", ["User"]),
      edge("services/user_service.py", "schemas/user.py", ["UserCreate"]),
      edge("services/user_service.py", "core/database.py", ["get_db"]),
      edge("services/user_service.py", "core/security.py", ["hash_password"]),
      edge("services/user_service.py", "core/exceptions.py", ["NotFoundError"]),
      edge("services/product_service.py", "models/product.py", ["Product"]),
      edge("services/product_service.py", "schemas/product.py", ["ProductCreate"]),
      edge("services/product_service.py", "core/database.py", ["get_db"]),
      edge("services/product_service.py", "core/exceptions.py", ["NotFoundError"]),
      edge("services/order_service.py", "models/order.py", ["Order"]),
      edge("services/order_service.py", "schemas/order.py", ["OrderCreate"]),
      edge("services/order_service.py", "core/database.py", ["get_db"]),
      edge("services/order_service.py", "core/exceptions.py", ["NotFoundError"]),
      edge("services/order_service.py", "services/product_service.py", ["check_stock"]),
      edge("services/email_service.py", "core/config.py", ["settings"]),

      // routes/ import services, schemas, core, and deps
      // Each route needs 5+ outgoing deps for instability > 0.8 (with fanIn=1 from main.py)
      edge("routes/users.py", "services/user_service.py", ["UserService"]),
      edge("routes/users.py", "schemas/user.py", ["UserCreate", "UserResponse"]),
      edge("routes/users.py", "deps.py", ["get_current_user"]),
      edge("routes/users.py", "core/exceptions.py", ["NotFoundError"]),
      edge("routes/users.py", "core/security.py", ["require_admin"]),
      edge("routes/products.py", "services/product_service.py", ["ProductService"]),
      edge("routes/products.py", "schemas/product.py", ["ProductCreate"]),
      edge("routes/products.py", "deps.py", ["get_current_user"]),
      edge("routes/products.py", "core/exceptions.py", ["NotFoundError"]),
      edge("routes/products.py", "core/security.py", ["require_admin"]),
      edge("routes/orders.py", "services/order_service.py", ["OrderService"]),
      edge("routes/orders.py", "schemas/order.py", ["OrderCreate"]),
      edge("routes/orders.py", "deps.py", ["get_current_user"]),
      edge("routes/orders.py", "core/exceptions.py", ["NotFoundError"]),
      edge("routes/orders.py", "core/security.py", ["require_auth"]),
      edge("routes/auth.py", "services/user_service.py", ["UserService"]),
      edge("routes/auth.py", "core/security.py", ["create_token"]),
      edge("routes/auth.py", "schemas/user.py", ["UserLogin"]),
      edge("routes/auth.py", "core/exceptions.py", ["AuthError"]),
      edge("routes/auth.py", "core/database.py", ["get_session"]),

      // tasks/ import services
      edge("tasks/send_email.py", "services/email_service.py", ["send"]),
      edge("tasks/send_email.py", "models/user.py", ["User"]),
      edge("tasks/process_order.py", "services/order_service.py", ["fulfill"]),
      edge("tasks/process_order.py", "models/order.py", ["Order"]),
      edge("tasks/cleanup.py", "core/database.py", ["get_db"]),

      // Entry points
      edge("deps.py", "core/security.py", ["verify_token"]),
      edge("deps.py", "core/database.py", ["get_db"]),
      edge("deps.py", "models/user.py", ["User"]),
      edge("middleware.py", "core/config.py", ["settings"]),
      edge("middleware.py", "core/exceptions.py", ["AppError"]),
      edge("main.py", "routes/users.py", ["router"]),
      edge("main.py", "routes/products.py", ["router"]),
      edge("main.py", "routes/orders.py", ["router"]),
      edge("main.py", "routes/auth.py", ["router"]),
      edge("main.py", "middleware.py", ["setup_middleware"]),
    ],
  },
  expectations: {
    // core/database.py has the most importers (models, services, deps, tasks, routes)
    topAuthorityFiles: ["core/database.py"],
    // Routes have many outgoing deps and only 1 incoming (from main.py): instability > 0.8
    highInstabilityFiles: ["routes/users.py", "routes/products.py", "routes/orders.py", "routes/auth.py"],
    // Core files should be stable
    stableFiles: ["core/config.py", "core/database.py", "models/base.py"],
    // Layer detection recognizes "services/" and "routes/" (as "pages" pattern).
    // "core/", "models/", "schemas/" are not in the built-in LAYER_PATTERNS.
    expectedLayerOrder: ["services"],
    // No cycles in clean architecture
    knownCycles: [],
    // core/database.py is a chokepoint (tasks/cleanup.py only connects through it)
    knownChokepoints: ["core/database.py"],
    minCommunities: 2,
    maxCommunities: 8,
    // core/config.py is a pure sink (no outgoing edges); directed betweenness = 0
    zeroBetweennessFiles: ["core/config.py"],
  },
};

export const BENCHMARK_FIXTURES: EvalFixture[] = [reactFullstack, pythonBackend];
