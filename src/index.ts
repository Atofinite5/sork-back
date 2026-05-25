import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { licenseAuth, clerkAuth } from "./middleware/auth.js";
import { runMigrations } from "./db/migrate.js";
import type { HonoEnv } from "./types.js";
import licenseRoutes from "./routes/license.js";
import byokRoutes from "./routes/byok.js";
import scanRoutes from "./routes/scan.js";
import scanTypesRoutes from "./routes/scantypes.js";
import aiRoutes from "./routes/ai.js";
import chatRoutes from "./routes/chat.js";
import usageRoutes from "./routes/usage.js";
import webhookRoutes from "./routes/webhooks.js";
import adminRoutes from "./routes/admin.js";
import statsRoutes from "./routes/stats.js";
import githubRoutes from "./routes/github.js";
import agentRoutes from "./routes/agent.js";
import ciRoutes from "./routes/ci.js";
import fixlearnRoutes from "./routes/fixlearn.js";

const app = new Hono();

app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack);
  return c.json({ error: err.message, stack: err.stack }, 500);
});

app.use(logger());
app.use(
  cors({
    origin: (origin) => {
      const allowed = [
        "https://sorkcloud.space",
        "https://www.sorkcloud.space",
        process.env.CLIENT_ORIGIN ?? "",
        "http://localhost:3000",
      ].filter(Boolean);
      return allowed.includes(origin ?? "") ? origin ?? "" : "";
    },
    allowHeaders: ["Authorization", "Content-Type", "x-clerk-user-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.get("/health", (c) => c.json({ status: "ok", version: "1.0.0" }));

app.get("/debug/db", async (c) => {
  try {
    const { db } = await import("./db/index.js");
    const { users } = await import("./db/schema.js");
    const { count } = await import("drizzle-orm");
    const [row] = await db.select({ n: count() }).from(users);
    return c.json({ ok: true, userCount: row?.n });
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ ok: false, error: e.message, stack: e.stack }, 500);
  }
});

// Webhook routes (no auth — verified via svix signature)
app.route("/webhooks", webhookRoutes);

// CLI routes — license key Bearer token auth
app.use("/api/scan/*", licenseAuth);
app.use("/api/scan", licenseAuth);
app.use("/api/ai/*", licenseAuth);
app.use("/api/ai", licenseAuth);
const cliApp = new Hono<HonoEnv>();
cliApp.route("/scan", scanRoutes);
cliApp.route("/ai", aiRoutes);
app.route("/api", cliApp);

// Dashboard routes — Clerk session header auth
app.use("/api/license/*", clerkAuth);
app.use("/api/license", clerkAuth);
app.use("/api/byok/*", clerkAuth);
app.use("/api/byok", clerkAuth);
app.use("/api/byok/status", clerkAuth);
app.use("/api/usage/*", clerkAuth);
app.use("/api/usage", clerkAuth);
app.use("/api/chat/*", clerkAuth);
app.use("/api/chat", clerkAuth);
app.use("/api/fixlearn/*", clerkAuth);
app.use("/api/fixlearn", clerkAuth);
app.use("/api/ci/setup", clerkAuth);
app.use("/api/ci/runs", clerkAuth);
app.use("/api/ci/webhooks", clerkAuth);
app.use("/api/admin/*", clerkAuth);
app.use("/api/stats/*", clerkAuth);
app.use("/api/stats", clerkAuth);
app.use("/api/admin", clerkAuth);

const dashApp = new Hono<HonoEnv>();
dashApp.route("/license", licenseRoutes);
dashApp.route("/byok", byokRoutes);
dashApp.route("/usage", usageRoutes);
dashApp.route("/chat", chatRoutes);
dashApp.route("/admin", adminRoutes);
dashApp.route("/stats", statsRoutes);
dashApp.route("/github", githubRoutes);
dashApp.route("/scan", scanTypesRoutes); // sub-routes: /sast /secrets /dependencies /iac /quality /licenses
dashApp.route("/agent", agentRoutes);    // /scan /heavy /status — multi-tier model routing
dashApp.route("/fixlearn", fixlearnRoutes); // /edit /preferences /history /insights — fix learning
dashApp.route("/ci", ciRoutes);            // /setup /runs /webhooks — CI dashboard
app.route("/api", dashApp);

// CI webhook receiver — no auth (verified via webhook signature)
app.route("/ci", ciRoutes);

// CI scan — license key auth for GitHub Action
app.use("/api/ci/scan", licenseAuth);

const port = Number(process.env.PORT ?? 8080);

// Run migrations (non-blocking — server starts regardless)
runMigrations()
  .then(() => console.log("Migrations complete ✓"))
  .catch((err) => console.error("Migration error (non-fatal):", err));

// Manual migration trigger endpoint for debugging
app.get("/migrate", async (c) => {
  try {
    await runMigrations();
    return c.json({ ok: true, message: "Migrations complete" });
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ ok: false, error: e.message }, 500);
  }
});

console.log(`SORK Backend running on port ${port}`);
serve({ fetch: app.fetch, port });

export default app;
