import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, KEY_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const i = stored.indexOf(":");
  if (i < 1) return false;
  const salt = Buffer.from(stored.slice(0, i), "hex");
  const expect = Buffer.from(stored.slice(i + 1), "hex");
  if (!salt.length || expect.length !== KEY_LEN) return false;
  const got = scryptSync(String(password), salt, KEY_LEN);
  return timingSafeEqual(got, expect);
}
