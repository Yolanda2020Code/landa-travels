import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_CV_BYTES = 5 * 1024 * 1024;
const OBJECT_PATH = /^\/objects\/recruitment\/[a-f0-9-]{36}\/[A-Za-z0-9._-]{1,120}$/;
export type FileCapability = { path: string; method: "GET" | "PUT"; expires: number };

export function validPrivatePath(path: string) {
  return OBJECT_PATH.test(path) && !path.includes("..");
}

function signingKey(key = process.env.PRIVATE_UPLOAD_SIGNING_KEY) {
  if (!key || key.length < 32) throw new Error("Private upload signing key is not configured.");
  return key;
}

export function issueFileCapability(
  path: string, method: "GET" | "PUT", key?: string, now = Date.now(),
) {
  if (!validPrivatePath(path)) throw new Error("Invalid private file path.");
  const payload = Buffer.from(JSON.stringify({ path, method, expires: Math.floor(now / 1000) + 900 })).toString("base64url");
  return `${payload}.${createHmac("sha256", signingKey(key)).update(payload).digest("base64url")}`;
}

export function verifyFileCapability(token: string, method: string, key?: string, now = Date.now()): FileCapability | null {
  try {
    if (token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
    const expected = createHmac("sha256", signingKey(key)).update(parts[0]!).digest();
    const supplied = Buffer.from(parts[1]!, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const body = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (typeof body.path !== "string" || !validPrivatePath(body.path) || body.method !== method ||
        !Number.isSafeInteger(body.expires) || body.expires <= Math.floor(now / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export function cvContentType(path: string): string | null {
  const name = path.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".doc")) return "application/msword";
  if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return null;
}

export function validCvBytes(content: Buffer, type: string) {
  if (!content.length || content.length > MAX_CV_BYTES) return false;
  if (type === "application/pdf") return content.subarray(0, 5).toString("ascii") === "%PDF-";
  if (type === "application/msword") return content.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return content.subarray(0, 4).equals(Buffer.from("504b0304", "hex"));
  }
  return false;
}