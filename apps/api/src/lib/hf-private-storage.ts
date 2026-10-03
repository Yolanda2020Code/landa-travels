import { spawn } from "node:child_process";
import { issueFileCapability, cvContentType, validPrivatePath } from "./private-upload-token";

export function usingHfPrivateStorage() {
  return process.env.RECRUITMENT_STORAGE_BACKEND === "huggingface";
}

export function privateFileUrl(path: string, method: "GET" | "PUT") {
  if (!process.env.HF_PRIVATE_UPLOAD_BUCKET || !process.env.HF_STORAGE_TOKEN) {
    throw new Error("Private storage bucket credentials are not configured.");
  }
  const base = process.env.PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base || !base.startsWith("https://")) throw new Error("Public application URL is not configured.");
  return `${base}/api/recruitment/files/${issueFileCapability(path, method)}`;
}

export function bucketOperation(
  operation: "put" | "get" | "head" | "delete", objectPath: string, content?: Buffer,
): Promise<{ size?: number; content?: string; stored?: boolean; deleted?: boolean } | null> {
  if (!validPrivatePath(objectPath)) throw new Error("Invalid private file path.");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.HF_STORAGE_PYTHON || "python",
      [process.env.HF_STORAGE_HELPER || "/app/deployment/hf-private-storage.py", operation, objectPath.slice("/objects/".length)],
      { stdio: ["pipe", "pipe", "ignore"], timeout: 90_000, killSignal: "SIGKILL" },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", () => reject(new Error("Private storage service is unavailable.")));
    child.stdin.on("error", () => reject(new Error("Private storage service is unavailable.")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("Private storage operation failed."));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Private storage returned an invalid response.")); }
    });
    child.stdin.end(content ? JSON.stringify({ content: content.toString("base64") }) : "");
  });
}

export async function inspectHfUpload(objectPath: string) {
  const metadata = await bucketOperation("head", objectPath);
  return metadata ? { size: metadata.size ?? 0, contentType: cvContentType(objectPath) ?? "" } : null;
}