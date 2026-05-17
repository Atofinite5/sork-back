import { Hono } from "hono";
import { getUserQuota } from "../lib/quota.js";

const usage = new Hono();

usage.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const quota = await getUserQuota(userId);
  return c.json(quota);
});

export default usage;
