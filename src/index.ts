import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { licenseAuth, clerkAuth } from "./middleware/auth.js";
import type { HonoEnv } from "./types.js";
import licenseRoutes from "./routes/license.js";
import byokRoutes from "./routes/byok.js";
import scanRoutes from "./routes/scan.js";
import chatRoutes from "./routes/chat.js";
import usageRoutes from "./routes/usage.js";
import webhookRoutes from "./routes/webhooks.js";
import adminRoutes from "./routes/admin.js";

const app = new Hono();

app.use(logger());
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000",
    allowHeaders: ["Authorization", "Content-Type", "x-clerk-user-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.get("/health", (c) => c.json({ status: "ok", version: "1.0.0" }));

// Webhook routes (no auth — verified via svix signature)
app.route("/webhooks", webhookRoutes);

// CLI routes — license key Bearer token auth (only /api/scan)
app.use("/api/scan/*", licenseAuth);
app.use("/api/scan", licenseAuth);
const cliApp = new Hono<HonoEnv>();
cliApp.route("/scan", scanRoutes);
app.route("/api", cliApp);

// Dashboard routes — Clerk session header auth
app.use("/api/license/*", clerkAuth);
app.use("/api/license", clerkAuth);
app.use("/api/byok/*", clerkAuth);
app.use("/api/byok", clerkAuth);
app.use("/api/usage/*", clerkAuth);
app.use("/api/usage", clerkAuth);
app.use("/api/chat/*", clerkAuth);
app.use("/api/chat", clerkAuth);
app.use("/api/admin/*", clerkAuth);
app.use("/api/admin", clerkAuth);

const dashApp = new Hono<HonoEnv>();
dashApp.route("/license", licenseRoutes);
dashApp.route("/byok", byokRoutes);
dashApp.route("/usage", usageRoutes);
dashApp.route("/chat", chatRoutes);
dashApp.route("/admin", adminRoutes);
app.route("/api", dashApp);

const port = Number(process.env.PORT ?? 8080);
console.log(`SORK Backend running on port ${port}`);

serve({ fetch: app.fetch, port });

export default app;
