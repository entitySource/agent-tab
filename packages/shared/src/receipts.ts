import { SignJWT, jwtVerify, importJWK, type JWK } from "jose";
import { ReceiptClaims } from "./schemas.js";

const ALG = "EdDSA";

export async function signReceipt(claims: ReceiptClaims, privateJwk: JWK, ttlSeconds = 120): Promise<string> {
  const key = await importJWK(privateJwk, ALG);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, typ: "agent-tab-receipt" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

/** Verified receipt claims plus the receipt's expiry in epoch seconds. */
export type VerifiedReceipt = ReceiptClaims & { exp: number };

export async function verifyReceipt(token: string, publicJwk: JWK): Promise<VerifiedReceipt> {
  const key = await importJWK(publicJwk, ALG);
  const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
  const claims = ReceiptClaims.parse(payload);
  if (typeof payload.exp !== "number") throw new Error("receipt has no expiry");
  return { ...claims, exp: payload.exp };
}
