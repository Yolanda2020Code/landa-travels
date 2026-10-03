import { randomUUID } from "node:crypto";

const SIGNING_URL = process.env.OBJECT_STORAGE_SIGNING_URL;
const PREFIX = "/objects/recruitment/";

function parsePath(path: string) {
  const parts = path.startsWith("/") ? path.slice(1).split("/") : path.split("/");
  if (parts.length < 2) throw new Error("Invalid object storage path.");
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

async function signedUrl(fullPath: string, method: "GET" | "PUT" | "HEAD" | "DELETE") {
  if (!SIGNING_URL) throw new Error("Private storage signing service is not configured.");
  const { bucketName, objectName } = parsePath(fullPath);
  const response = await fetch(SIGNING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Unable to prepare private file storage.");
  const body = await response.json() as { signed_url: string };
  return body.signed_url;
}

function privateDirectory() {
  const value = process.env.PRIVATE_OBJECT_DIR;
  if (!value) throw new Error("Private object storage is not configured.");
  return value.replace(/\/$/, "");
}

function fullPathFromObjectPath(objectPath: string) {
  if (!objectPath.startsWith(PREFIX) || objectPath.includes("..")) {
    throw new Error("Invalid recruitment file path.");
  }
  return `${privateDirectory()}/${objectPath.slice("/objects/".length)}`;
}

export async function createRecruitmentUpload(fileName: string) {
  const safeName = fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  const relative = `recruitment/${randomUUID()}/${safeName}`;
  const fullPath = `${privateDirectory()}/${relative}`;
  return {
    uploadUrl: await signedUrl(fullPath, "PUT"),
    objectPath: `/objects/${relative}`,
    expiresInSeconds: 900,
  };
}

export async function inspectRecruitmentUpload(objectPath: string) {
  const url = await signedUrl(fullPathFromObjectPath(objectPath), "HEAD");
  const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  return {
    size: Number(response.headers.get("content-length") || "0"),
    contentType: (response.headers.get("content-type") || "").split(";")[0].trim(),
  };
}

export async function createRecruitmentDownload(objectPath: string) {
  return signedUrl(fullPathFromObjectPath(objectPath), "GET");
}

export async function deleteRecruitmentUpload(objectPath: string) {
  const url = await signedUrl(fullPathFromObjectPath(objectPath), "DELETE");
  const response = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Private file deletion failed with status ${response.status}.`);
  }
}