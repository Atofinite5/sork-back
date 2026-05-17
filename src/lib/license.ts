import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? "dev-secret-change-me");

export function generateLicenseKey(): string {
  return `sork_live_${randomBytes(24).toString("hex")}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function keyPrefix(key: string): string {
  return key.slice(0, 14);
}

export interface LicensePayload {
  userId: string;
  keyId: string;
  plan: string;
  expiresAt?: number;
}

export async function signLicenseJWT(payload: LicensePayload): Promise<string> {
  const jwt = new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("sork-cloud");

  if (payload.expiresAt) {
    jwt.setExpirationTime(payload.expiresAt);
  }

  return jwt.sign(JWT_SECRET);
}

export async function verifyLicenseJWT(token: string): Promise<LicensePayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { issuer: "sork-cloud" });
    return payload as unknown as LicensePayload;
  } catch {
    return null;
  }
}
