export function isAdmin(clerkId: string): boolean {
  const admins = (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(clerkId);
}
