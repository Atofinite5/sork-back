import { Hono } from "hono";
import type { HonoEnv } from "../types.js";
import { getUserQuota } from "../lib/quota.js";

const usage = new Hono<HonoEnv>();

usage.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const quota = await getUserQuota(userId);
  return c.json(quota);
});

export default usage;
