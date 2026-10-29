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

export async function verifyReceipt(token: string, publicJwk: JWK): Promise<ReceiptClaims> {
  const key = await importJWK(publicJwk, ALG);
  const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
  return ReceiptClaims.parse(payload);
}
