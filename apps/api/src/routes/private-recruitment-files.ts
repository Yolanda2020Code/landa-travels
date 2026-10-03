import express, { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, recruitmentUploadsTable } from "@workspace/db";
import { bucketOperation, usingHfPrivateStorage } from "../lib/hf-private-storage";
import { verifyFileCapability, validCvBytes, cvContentType, MAX_CV_BYTES } from "../lib/private-upload-token";

const router: IRouter = Router();

router.all("/recruitment/files/:token", (req, res, next) => {
  if (!usingHfPrivateStorage()) { res.sendStatus(404); return; }
  const capability = verifyFileCapability(String(req.params.token), req.method);
  if (!capability) { res.sendStatus(403); return; }
  res.locals.fileCapability = capability;
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  next();
});

router.put("/recruitment/files/:token", express.raw({ type: () => true, limit: MAX_CV_BYTES }), async (req, res): Promise<void> => {
  const { path } = res.locals.fileCapability;
  const type = cvContentType(path);
  if (!Buffer.isBuffer(req.body) || !type || !validCvBytes(req.body, type)) {
    res.status(400).json({ error: "The file content does not match a supported CV format." }); return;
  }
  const [reserved] = await db.update(recruitmentUploadsTable).set({ uploadedAt: new Date() })
    .where(and(eq(recruitmentUploadsTable.objectPath, path), isNull(recruitmentUploadsTable.uploadedAt)))
    .returning({ id: recruitmentUploadsTable.id });
  if (!reserved) { res.status(410).json({ error: "This upload has expired or was already used." }); return; }
  try {
    const result = await bucketOperation("put", path, req.body);
    if (!result?.stored) throw new Error("File storage did not confirm the upload.");
    res.sendStatus(204);
  } catch {
    await db.update(recruitmentUploadsTable).set({ uploadedAt: null }).where(eq(recruitmentUploadsTable.id, reserved.id));
    res.status(503).json({ error: "Private CV storage is temporarily unavailable." });
  }
});

router.get("/recruitment/files/:token", async (_req, res): Promise<void> => {
  const { path } = res.locals.fileCapability;
  try {
    const result = await bucketOperation("get", path);
    if (!result?.content) { res.sendStatus(404); return; }
    res.set({ "Content-Type": cvContentType(path) ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.split("/").at(-1)}"` });
    res.send(Buffer.from(result.content, "base64"));
  } catch {
    res.status(503).json({ error: "Private CV storage is temporarily unavailable." });
  }
});

export default router;