// One shared password for the hosted booth (BOOTH_PASSWORD). The session cookie is an HMAC of the
// password, so changing the password signs everyone out.
import crypto from "node:crypto";

const COOKIE = "booth_session";
const MAX_AGE = 30 * 86400;

const token = () => crypto.createHmac("sha256", process.env.BOOTH_PASSWORD).update("voice-booth session").digest("base64url");

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const hasPassword = () => Boolean(process.env.BOOTH_PASSWORD);

export const signedIn = (request) => {
  if (!hasPassword()) return false;
  const cookie = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return Boolean(cookie) && same(cookie.slice(COOKIE.length + 1), token());
};

// The Set-Cookie value for a correct password, or null.
export const signIn = (password) =>
  hasPassword() && same(password ?? "", process.env.BOOTH_PASSWORD) ? `${COOKIE}=${token()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}` : null;

export const signOut = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
