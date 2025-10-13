/**
 * Test fixtures for algorithm evaluation.
 *
 * Each fixture defines a synthetic but realistic project graph with known
 * structural properties. Ground truth expectations are hand-verified so
 * that algorithm outputs can be validated without LLM-in-the-loop evaluation.
 */

import type { ImportEdge } from "../../types.js";
import { edge } from "./helpers.js";

// ── Fixture type definition ───────────────────────────────────────────

export interface EvalFixture {
  name: string;
  description: string;
  /** The import graph definition */
  graph: { edges: ImportEdge[]; files: string[] };
  /** Ground truth assertions */
  expectations: {
    /** Files that MUST appear in top-N hub files, in rough order */
    topHubFiles?: string[];
    /** Files that MUST have highest authority scores */
    topAuthorityFiles?: string[];
    /** Known circular dependencies that must be detected */
    knownCycles?: string[][];
    /** Files that should be detected as dead */
    knownDeadFiles?: string[];
    /** Expected layer ordering (foundational first) */
    expectedLayerOrder?: string[];
    /** Files that should have high instability (> 0.8) */
    highInstabilityFiles?: string[];
    /** Minimum number of communities expected */
    minCommunities?: number;
    /** Maximum number of communities expected */
    maxCommunities?: number;
  };
}

// ── Fixture 1: Layered Architecture ───────────────────────────────────

/**
 * Classic layered architecture: types -> utils -> services -> controllers -> routes
 *
 * types/index.ts is the foundation (imported by everything).
 * routes/ files sit at the top and have highest instability.
 * Each layer only imports from layers below it (clean dependency flow).
 */
const layeredApp: EvalFixture = {
  name: "layered-app",
  description: "Classic layered architecture with clean dependency flow from types through routes",
  graph: {
    files: [
      // Foundation layer
      "types/index.ts",
      "types/user.ts",
      "types/product.ts",
      // Utility layer
      "utils/format.ts",
      "utils/validate.ts",
      "utils/logger.ts",
      // Service layer
      "services/user-service.ts",
      "services/product-service.ts",
      "services/auth-service.ts",
      // Controller layer
      "controllers/user-controller.ts",
      "controllers/product-controller.ts",
      "controllers/auth-controller.ts",
      // Route layer (top, most unstable)
      "routes/user-routes.ts",
      "routes/product-routes.ts",
      "routes/auth-routes.ts",
      // Entry point that imports routes (gives routes fanIn >= 1)
      "app.ts",
    ],
    edges: [
      // types/user.ts and types/product.ts import from types/index.ts
      edge("types/user.ts", "types/index.ts", ["BaseEntity"]),
      edge("types/product.ts", "types/index.ts", ["BaseEntity"]),

      // utils import types
      edge("utils/format.ts", "types/index.ts", ["BaseEntity"]),
      edge("utils/validate.ts", "types/index.ts", ["BaseEntity"]),
      edge("utils/validate.ts", "types/user.ts", ["User"]),
      edge("utils/validate.ts", "types/product.ts", ["Product"]),
      edge("utils/logger.ts", "types/index.ts", ["BaseEntity"]),

      // services import types and utils
      edge("services/user-service.ts", "types/index.ts", ["BaseEntity"]),
      edge("services/user-service.ts", "types/user.ts", ["User"]),
      edge("services/user-service.ts", "utils/validate.ts", ["validateUser"]),
      edge("services/user-service.ts", "utils/logger.ts", ["log"]),

      edge("services/product-service.ts", "types/index.ts", ["BaseEntity"]),
      edge("services/product-service.ts", "types/product.ts", ["Product"]),
      edge("services/product-service.ts", "utils/validate.ts", ["validateProduct"]),
      edge("services/product-service.ts", "utils/logger.ts", ["log"]),

      edge("services/auth-service.ts", "types/index.ts", ["BaseEntity"]),
      edge("services/auth-service.ts", "types/user.ts", ["User"]),
      edge("services/auth-service.ts", "utils/logger.ts", ["log"]),

      // controllers import services and types
      edge("controllers/user-controller.ts", "services/user-service.ts", ["UserService"]),
      edge("controllers/user-controller.ts", "types/user.ts", ["User"]),
      edge("controllers/user-controller.ts", "utils/logger.ts", ["log"]),

      edge("controllers/product-controller.ts", "services/product-service.ts", ["ProductService"]),
      edge("controllers/product-controller.ts", "types/product.ts", ["Product"]),
      edge("controllers/product-controller.ts", "utils/logger.ts", ["log"]),

      edge("controllers/auth-controller.ts", "services/auth-service.ts", ["AuthService"]),
      edge("controllers/auth-controller.ts", "types/user.ts", ["User"]),

      // routes import controllers, types, and utils (top layer, many outgoing deps)
      edge("routes/user-routes.ts", "controllers/user-controller.ts", ["userController"]),
      edge("routes/user-routes.ts", "types/user.ts", ["User"]),
      edge("routes/user-routes.ts", "types/index.ts", ["BaseEntity"]),
      edge("routes/user-routes.ts", "utils/validate.ts", ["validate"]),
      edge("routes/user-routes.ts", "utils/logger.ts", ["log"]),

      edge("routes/product-routes.ts", "controllers/product-controller.ts", ["productController"]),
      edge("routes/product-routes.ts", "types/product.ts", ["Product"]),
      edge("routes/product-routes.ts", "types/index.ts", ["BaseEntity"]),
      edge("routes/product-routes.ts", "utils/validate.ts", ["validate"]),
      edge("routes/product-routes.ts", "utils/logger.ts", ["log"]),

      edge("routes/auth-routes.ts", "controllers/auth-controller.ts", ["authController"]),
      edge("routes/auth-routes.ts", "types/user.ts", ["User"]),
      edge("routes/auth-routes.ts", "types/index.ts", ["BaseEntity"]),
      edge("routes/auth-routes.ts", "utils/validate.ts", ["validate"]),
      edge("routes/auth-routes.ts", "utils/logger.ts", ["log"]),

      // app.ts imports all routes (gives each route fanIn = 1)
      edge("app.ts", "routes/user-routes.ts", ["userRoutes"]),
      edge("app.ts", "routes/product-routes.ts", ["productRoutes"]),
      edge("app.ts", "routes/auth-routes.ts", ["authRoutes"]),
    ],
  },
  expectations: {
    // types/index.ts is the most foundational file (highest authority)
    topAuthorityFiles: ["types/index.ts", "types/user.ts"],
    // types layer should be most foundational (imported by most layers)
    expectedLayerOrder: ["types", "utils", "services"],
    // Route files have many outgoing deps but few incoming; instability > 0.8
    highInstabilityFiles: [
      "routes/user-routes.ts",
      "routes/product-routes.ts",
      "routes/auth-routes.ts",
    ],
  },
};

// ── Fixture 2: Hub and Spoke ──────────────────────────────────────────

/**
 * One central file (api-client.ts) imported by many leaf feature files.
 * The hub should have the highest authority score.
 * Leaf files that nothing imports are dead-file candidates.
 * Also includes a shared config file to add a secondary hub.
 */
const hubAndSpoke: EvalFixture = {
  name: "hub-and-spoke",
  description: "Central api-client.ts imported by many leaf files; leaves are dead-file candidates",
  graph: {
    files: [
      "lib/api-client.ts",
      "lib/config.ts",
      "features/dashboard.ts",
      "features/profile.ts",
      "features/settings.ts",
      "features/analytics.ts",
      "features/billing.ts",
      "features/notifications.ts",
      "features/search.ts",
      "features/admin.ts",
    ],
    edges: [
      // All features import api-client
      edge("features/dashboard.ts", "lib/api-client.ts", ["get", "post"]),
      edge("features/profile.ts", "lib/api-client.ts", ["get", "put"]),
      edge("features/settings.ts", "lib/api-client.ts", ["get", "put"]),
      edge("features/analytics.ts", "lib/api-client.ts", ["get"]),
      edge("features/billing.ts", "lib/api-client.ts", ["get", "post"]),
      edge("features/notifications.ts", "lib/api-client.ts", ["get"]),
      edge("features/search.ts", "lib/api-client.ts", ["get", "post"]),
      edge("features/admin.ts", "lib/api-client.ts", ["get", "post", "del"]),

      // api-client imports config
      edge("lib/api-client.ts", "lib/config.ts", ["API_BASE_URL"]),

      // A few features also import config directly
      edge("features/dashboard.ts", "lib/config.ts", ["DASHBOARD_URL"]),
      edge("features/admin.ts", "lib/config.ts", ["ADMIN_URL"]),
    ],
  },
  expectations: {
    // api-client.ts is the primary hub (highest authority, imported by 8 files)
    topAuthorityFiles: ["lib/api-client.ts", "lib/config.ts"],
    // Leaf files with zero importers should be detected as dead files.
    // Note: findDeadFiles skips index/main/app entry points, but
    // these feature files are not conventional entry points.
    knownDeadFiles: [
      "features/profile.ts",
      "features/settings.ts",
      "features/analytics.ts",
      "features/billing.ts",
      "features/notifications.ts",
      "features/search.ts",
    ],
  },
};

// ── Fixture 3: Circular Dependency Mess ───────────────────────────────

/**
 * A graph with 3 known circular dependencies of different sizes:
 * 1. A <-> B (2-node cycle)
 * 2. C -> D -> E -> C (3-node cycle)
 * 3. F -> G -> H -> I -> F (4-node cycle)
 *
 * Also includes non-cyclic files to verify they are not flagged.
 */
const circularMess: EvalFixture = {
  name: "circular-mess",
  description: "Graph with 3 known circular dependencies of sizes 2, 3, and 4",
  graph: {
    files: [
      // 2-cycle
      "modules/a.ts",
      "modules/b.ts",
      // 3-cycle
      "modules/c.ts",
      "modules/d.ts",
      "modules/e.ts",
      // 4-cycle
      "modules/f.ts",
      "modules/g.ts",
      "modules/h.ts",
      "modules/i.ts",
      // Non-cyclic files
      "modules/clean-x.ts",
      "modules/clean-y.ts",
      "modules/clean-z.ts",
    ],
    edges: [
      // 2-cycle: A <-> B
      edge("modules/a.ts", "modules/b.ts", ["doB"]),
      edge("modules/b.ts", "modules/a.ts", ["doA"]),

      // 3-cycle: C -> D -> E -> C
      edge("modules/c.ts", "modules/d.ts", ["doD"]),
      edge("modules/d.ts", "modules/e.ts", ["doE"]),
      edge("modules/e.ts", "modules/c.ts", ["doC"]),

      // 4-cycle: F -> G -> H -> I -> F
      edge("modules/f.ts", "modules/g.ts", ["doG"]),
      edge("modules/g.ts", "modules/h.ts", ["doH"]),
      edge("modules/h.ts", "modules/i.ts", ["doI"]),
      edge("modules/i.ts", "modules/f.ts", ["doF"]),

      // Non-cyclic edges (clean chain)
      edge("modules/clean-x.ts", "modules/clean-y.ts", ["doY"]),
      edge("modules/clean-y.ts", "modules/clean-z.ts", ["doZ"]),

      // Cross edges (connect cycles to non-cyclic, but don't create new cycles)
      edge("modules/clean-x.ts", "modules/a.ts", ["doA"]),
      edge("modules/clean-x.ts", "modules/c.ts", ["doC"]),
    ],
  },
  expectations: {
    // All three cycle groups must be detected as SCCs
    knownCycles: [
      ["modules/a.ts", "modules/b.ts"],
      ["modules/c.ts", "modules/d.ts", "modules/e.ts"],
      ["modules/f.ts", "modules/g.ts", "modules/h.ts", "modules/i.ts"],
    ],
  },
};

// ── Fixture 4: Monolith with Community Structure ──────────────────────

/**
 * Large project (50+ files) where graph-based communities diverge from
 * directory structure. This is critical: the algorithm returns empty when
 * communities merely mirror directories (ARI > 0.85).
 *
 * Strategy: files are organized into directories by team ownership, but
 * the actual import graph forms functional clusters that cross directories.
 * For example, "order processing" functionality spans files in backend/,
 * frontend/, and shared/, creating a community that differs from the
 * directory tree.
 *
 * Functional clusters (differ from directory layout):
 *   Cluster A "user management": backend/user-*, frontend/profile-*, frontend/auth-*,
 *                                shared/user-types, shared/auth-utils
 *   Cluster B "order processing": backend/order-*, frontend/checkout-*, frontend/cart-*,
 *                                 shared/order-types, shared/payment-utils
 *   Cluster C "content/catalog":  backend/product-*, frontend/catalog-*, frontend/search-*,
 *                                 shared/product-types
 *   Cluster D "analytics":        backend/analytics-*, frontend/dashboard-*, shared/metrics
 */
function buildMonolithFiles(): string[] {
  return [
    // backend/ directory (13 files, spanning all functional clusters)
    "backend/user-service.ts",
    "backend/user-repo.ts",
    "backend/user-validator.ts",
    "backend/order-service.ts",
    "backend/order-repo.ts",
    "backend/order-processor.ts",
    "backend/product-service.ts",
    "backend/product-repo.ts",
    "backend/product-indexer.ts",
    "backend/analytics-collector.ts",
    "backend/analytics-aggregator.ts",
    "backend/analytics-exporter.ts",
    "backend/middleware.ts",
    // frontend/ directory (13 files, spanning all functional clusters)
    "frontend/profile-page.ts",
    "frontend/profile-edit.ts",
    "frontend/auth-login.ts",
    "frontend/auth-register.ts",
    "frontend/checkout-page.ts",
    "frontend/checkout-summary.ts",
    "frontend/cart-view.ts",
    "frontend/cart-item.ts",
    "frontend/catalog-list.ts",
    "frontend/catalog-detail.ts",
    "frontend/search-bar.ts",
    "frontend/search-results.ts",
    "frontend/dashboard-main.ts",
    // shared/ directory (10 files, utilities spanning all clusters)
    "shared/user-types.ts",
    "shared/auth-utils.ts",
    "shared/order-types.ts",
    "shared/payment-utils.ts",
    "shared/product-types.ts",
    "shared/metrics.ts",
    "shared/api-client.ts",
    "shared/logger.ts",
    "shared/config.ts",
    "shared/errors.ts",
    // infra/ directory (6 files, cross-cutting)
    "infra/db-connection.ts",
    "infra/cache.ts",
    "infra/queue.ts",
    "infra/email-sender.ts",
    "infra/storage.ts",
    "infra/http-client.ts",
    // worker/ directory (6 files)
    "worker/order-worker.ts",
    "worker/email-worker.ts",
    "worker/analytics-worker.ts",
    "worker/indexer-worker.ts",
    "worker/cleanup-worker.ts",
    "worker/base-worker.ts",
  ];
}

function buildMonolithEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];

  // ── Cluster A: User management ──────────────────────────────────────
  // Dense cross-directory edges forming a user-management community
  edges.push(edge("backend/user-service.ts", "backend/user-repo.ts", ["UserRepo"]));
  edges.push(edge("backend/user-service.ts", "backend/user-validator.ts", ["validateUser"]));
  edges.push(edge("backend/user-service.ts", "shared/user-types.ts", ["User", "UserRole"]));
  edges.push(edge("backend/user-service.ts", "shared/auth-utils.ts", ["hashPassword"]));
  edges.push(edge("backend/user-repo.ts", "shared/user-types.ts", ["User"]));
  edges.push(edge("backend/user-repo.ts", "infra/db-connection.ts", ["getDb"]));
  edges.push(edge("backend/user-validator.ts", "shared/user-types.ts", ["User"]));
  edges.push(edge("backend/user-validator.ts", "shared/errors.ts", ["ValidationError"]));
  edges.push(edge("frontend/profile-page.ts", "shared/user-types.ts", ["User"]));
  edges.push(edge("frontend/profile-page.ts", "frontend/profile-edit.ts", ["ProfileEdit"]));
  edges.push(edge("frontend/profile-page.ts", "shared/api-client.ts", ["get"]));
  edges.push(edge("frontend/profile-edit.ts", "shared/user-types.ts", ["User"]));
  edges.push(edge("frontend/profile-edit.ts", "shared/api-client.ts", ["put"]));
  edges.push(edge("frontend/auth-login.ts", "shared/auth-utils.ts", ["login"]));
  edges.push(edge("frontend/auth-login.ts", "shared/user-types.ts", ["User"]));
  edges.push(edge("frontend/auth-login.ts", "shared/api-client.ts", ["post"]));
  edges.push(edge("frontend/auth-register.ts", "shared/auth-utils.ts", ["register"]));
  edges.push(edge("frontend/auth-register.ts", "shared/user-types.ts", ["User"]));
  edges.push(edge("frontend/auth-register.ts", "shared/api-client.ts", ["post"]));

  // ── Cluster B: Order processing ─────────────────────────────────────
  edges.push(edge("backend/order-service.ts", "backend/order-repo.ts", ["OrderRepo"]));
  edges.push(edge("backend/order-service.ts", "backend/order-processor.ts", ["processOrder"]));
  edges.push(edge("backend/order-service.ts", "shared/order-types.ts", ["Order", "OrderStatus"]));
  edges.push(edge("backend/order-service.ts", "shared/payment-utils.ts", ["chargeCard"]));
  edges.push(edge("backend/order-repo.ts", "shared/order-types.ts", ["Order"]));
  edges.push(edge("backend/order-repo.ts", "infra/db-connection.ts", ["getDb"]));
  edges.push(edge("backend/order-processor.ts", "shared/order-types.ts", ["Order"]));
  edges.push(edge("backend/order-processor.ts", "shared/payment-utils.ts", ["refund"]));
  edges.push(edge("backend/order-processor.ts", "infra/queue.ts", ["enqueue"]));
  edges.push(edge("frontend/checkout-page.ts", "shared/order-types.ts", ["Order"]));
  edges.push(edge("frontend/checkout-page.ts", "frontend/checkout-summary.ts", ["Summary"]));
  edges.push(edge("frontend/checkout-page.ts", "shared/api-client.ts", ["post"]));
  edges.push(edge("frontend/checkout-page.ts", "shared/payment-utils.ts", ["validateCard"]));
  edges.push(edge("frontend/checkout-summary.ts", "shared/order-types.ts", ["Order"]));
  edges.push(edge("frontend/cart-view.ts", "shared/order-types.ts", ["CartItem"]));
  edges.push(edge("frontend/cart-view.ts", "frontend/cart-item.ts", ["CartItemComponent"]));
  edges.push(edge("frontend/cart-view.ts", "shared/api-client.ts", ["post"]));
  edges.push(edge("frontend/cart-item.ts", "shared/order-types.ts", ["CartItem"]));

  // ── Cluster C: Content/catalog ──────────────────────────────────────
  edges.push(edge("backend/product-service.ts", "backend/product-repo.ts", ["ProductRepo"]));
  edges.push(edge("backend/product-service.ts", "backend/product-indexer.ts", ["reindex"]));
  edges.push(edge("backend/product-service.ts", "shared/product-types.ts", ["Product"]));
  edges.push(edge("backend/product-repo.ts", "shared/product-types.ts", ["Product"]));
  edges.push(edge("backend/product-repo.ts", "infra/db-connection.ts", ["getDb"]));
  edges.push(edge("backend/product-indexer.ts", "shared/product-types.ts", ["Product"]));
  edges.push(edge("backend/product-indexer.ts", "infra/cache.ts", ["invalidate"]));
  edges.push(edge("frontend/catalog-list.ts", "shared/product-types.ts", ["Product"]));
  edges.push(edge("frontend/catalog-list.ts", "frontend/catalog-detail.ts", ["DetailLink"]));
  edges.push(edge("frontend/catalog-list.ts", "shared/api-client.ts", ["get"]));
  edges.push(edge("frontend/catalog-detail.ts", "shared/product-types.ts", ["Product"]));
  edges.push(edge("frontend/catalog-detail.ts", "shared/api-client.ts", ["get"]));
  edges.push(edge("frontend/search-bar.ts", "frontend/search-results.ts", ["SearchResults"]));
  edges.push(edge("frontend/search-bar.ts", "shared/api-client.ts", ["get"]));
  edges.push(edge("frontend/search-results.ts", "shared/product-types.ts", ["Product"]));
  edges.push(edge("frontend/search-results.ts", "shared/api-client.ts", ["get"]));

  // ── Cluster D: Analytics ────────────────────────────────────────────
  edges.push(edge("backend/analytics-collector.ts", "backend/analytics-aggregator.ts", ["aggregate"]));
  edges.push(edge("backend/analytics-collector.ts", "shared/metrics.ts", ["MetricEvent"]));
  edges.push(edge("backend/analytics-collector.ts", "infra/queue.ts", ["enqueue"]));
  edges.push(edge("backend/analytics-aggregator.ts", "shared/metrics.ts", ["MetricEvent"]));
  edges.push(edge("backend/analytics-aggregator.ts", "infra/db-connection.ts", ["getDb"]));
  edges.push(edge("backend/analytics-exporter.ts", "backend/analytics-aggregator.ts", ["getAggregated"]));
  edges.push(edge("backend/analytics-exporter.ts", "shared/metrics.ts", ["MetricEvent"]));
  edges.push(edge("backend/analytics-exporter.ts", "infra/storage.ts", ["upload"]));
  edges.push(edge("frontend/dashboard-main.ts", "shared/metrics.ts", ["MetricEvent"]));
  edges.push(edge("frontend/dashboard-main.ts", "shared/api-client.ts", ["get"]));

  // ── Infrastructure (shared, cross-cutting) ──────────────────────────
  edges.push(edge("infra/db-connection.ts", "shared/config.ts", ["DB_URL"]));
  edges.push(edge("infra/cache.ts", "shared/config.ts", ["REDIS_URL"]));
  edges.push(edge("infra/queue.ts", "shared/config.ts", ["QUEUE_URL"]));
  edges.push(edge("infra/email-sender.ts", "shared/config.ts", ["SMTP_HOST"]));
  edges.push(edge("infra/email-sender.ts", "shared/logger.ts", ["log"]));
  edges.push(edge("infra/storage.ts", "shared/config.ts", ["S3_BUCKET"]));
  edges.push(edge("infra/http-client.ts", "shared/config.ts", ["API_BASE"]));
  edges.push(edge("infra/http-client.ts", "shared/logger.ts", ["log"]));

  // ── Workers (use backend + infra) ───────────────────────────────────
  edges.push(edge("worker/base-worker.ts", "shared/logger.ts", ["log"]));
  edges.push(edge("worker/base-worker.ts", "infra/queue.ts", ["dequeue"]));
  edges.push(edge("worker/order-worker.ts", "worker/base-worker.ts", ["BaseWorker"]));
  edges.push(edge("worker/order-worker.ts", "backend/order-processor.ts", ["processOrder"]));
  edges.push(edge("worker/email-worker.ts", "worker/base-worker.ts", ["BaseWorker"]));
  edges.push(edge("worker/email-worker.ts", "infra/email-sender.ts", ["sendEmail"]));
  edges.push(edge("worker/analytics-worker.ts", "worker/base-worker.ts", ["BaseWorker"]));
  edges.push(edge("worker/analytics-worker.ts", "backend/analytics-collector.ts", ["collect"]));
  edges.push(edge("worker/indexer-worker.ts", "worker/base-worker.ts", ["BaseWorker"]));
  edges.push(edge("worker/indexer-worker.ts", "backend/product-indexer.ts", ["reindex"]));
  edges.push(edge("worker/cleanup-worker.ts", "worker/base-worker.ts", ["BaseWorker"]));
  edges.push(edge("worker/cleanup-worker.ts", "infra/db-connection.ts", ["getDb"]));

  // ── Middleware (cross-cutting) ──────────────────────────────────────
  edges.push(edge("backend/middleware.ts", "shared/auth-utils.ts", ["verifyToken"]));
  edges.push(edge("backend/middleware.ts", "shared/logger.ts", ["log"]));
  edges.push(edge("backend/middleware.ts", "shared/errors.ts", ["AuthError"]));

  // ── A few domain-crossing imports (realistic coupling) ──────────────
  // Order processing needs user info
  edges.push(edge("backend/order-service.ts", "shared/user-types.ts", ["UserId"]));
  // Checkout shows product info
  edges.push(edge("frontend/checkout-page.ts", "shared/product-types.ts", ["Product"]));
  // Dashboard shows order stats
  edges.push(edge("frontend/dashboard-main.ts", "shared/order-types.ts", ["OrderStats"]));

  return edges;
}

const monolith: EvalFixture = {
  name: "monolith",
  description: "Large codebase (48 files) where functional clusters cross directory boundaries",
  graph: {
    files: buildMonolithFiles(),
    edges: buildMonolithEdges(),
  },
  expectations: {
    // shared/api-client.ts is imported by many clusters; should have high authority
    topAuthorityFiles: ["shared/api-client.ts"],
    // Community detection should find meaningful groups that differ from directory structure.
    // The 4 functional clusters (user, order, catalog, analytics) plus infra/worker groups
    // should produce at least 3 communities after merging small ones.
    minCommunities: 3,
    maxCommunities: 12,
  },
};

// ── Export all fixtures ───────────────────────────────────────────────

export const EVAL_FIXTURES: EvalFixture[] = [
  layeredApp,
  hubAndSpoke,
  circularMess,
  monolith,
];

export { layeredApp, hubAndSpoke, circularMess, monolith };
