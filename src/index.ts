import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { licenseAuth, clerkAuth } from "./middleware/auth.js";
import licenseRoutes from "./routes/license.js";
import byokRoutes from "./routes/byok.js";
import scanRoutes from "./routes/scan.js";
import chatRoutes from "./routes/chat.js";
import usageRoutes from "./routes/usage.js";
import webhookRoutes from "./routes/webhooks.js";

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

// License-key authenticated routes (CLI / scan usage)
const apiWithLicenseAuth = new Hono();
apiWithLicenseAuth.use("*", licenseAuth);
apiWithLicenseAuth.route("/scan", scanRoutes);

// Clerk session authenticated routes (dashboard)
const apiWithClerkAuth = new Hono();
apiWithClerkAuth.use("*", clerkAuth);
apiWithClerkAuth.route("/license", licenseRoutes);
apiWithClerkAuth.route("/byok", byokRoutes);
apiWithClerkAuth.route("/usage", usageRoutes);
apiWithClerkAuth.route("/chat", chatRoutes);

app.route("/api", apiWithLicenseAuth);
app.route("/api", apiWithClerkAuth);

const port = Number(process.env.PORT ?? 8080);
console.log(`SORK Backend running on port ${port}`);

serve({ fetch: app.fetch, port });

export default app;
