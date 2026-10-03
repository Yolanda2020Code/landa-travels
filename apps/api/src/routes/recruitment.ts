import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, recruitmentApplicationsTable, recruitmentUploadsTable } from "@workspace/db";
import {
  RequestRecruitmentUploadBody,
  RequestRecruitmentUploadResponse,
  SubmitRecruitmentApplicationBody,
  SubmitRecruitmentApplicationResponse,
} from "@workspace/api-zod";
import {
  createRecruitmentUpload,
  createRecruitmentDownload,
  deleteRecruitmentUpload,
  inspectRecruitmentUpload,
} from "../lib/recruitment-storage";
import { cleanupRecruitmentRetention } from "../services/recruitment-retention";
import { requireRecruitmentOwner } from "../middlewares/requireRecruitmentOwner";

const router: IRouter = Router();
const MAX_SIZE = 5 * 1024 * 1024;
const allowedFiles = new Map([
  ["application/pdf", [".pdf"]],
  ["application/msword", [".doc"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
]);
const uploadRequests = new Map<string, { count: number; resetAt: number }>();

router.get("/admin/recruitment/applications", requireRecruitmentOwner, async (req, res): Promise<void> => {
  try {
    await cleanupRecruitmentRetention();
    const applications = await db.select({
      id: recruitmentApplicationsTable.id,
      name: recruitmentApplicationsTable.name,
      email: recruitmentApplicationsTable.email,
      details: recruitmentApplicationsTable.details,
      cvFileName: recruitmentApplicationsTable.cvFileName,
      cvSize: recruitmentApplicationsTable.cvSize,
      createdAt: recruitmentApplicationsTable.createdAt,
      retentionExpiresAt: recruitmentApplicationsTable.retentionExpiresAt,
      cvObjectPath: recruitmentApplicationsTable.cvObjectPath,
    })
      .from(recruitmentApplicationsTable)
      .orderBy(desc(recruitmentApplicationsTable.createdAt));

    const result = await Promise.all(applications.map(async ({ cvObjectPath, ...application }) => ({
      ...application,
      cvDownloadUrl: await createRecruitmentDownload(cvObjectPath),
    })));
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "Failed to load private recruitment applications");
    res.status(500).json({ error: "Applications could not be loaded." });
  }
});

function validExtension(name: string, type: string) {
  return (allowedFiles.get(type) ?? []).some((extension) => name.toLowerCase().endsWith(extension));
}

function uploadRateLimited(ip: string) {
  const now = Date.now();
  const current = uploadRequests.get(ip);
  if (!current || current.resetAt <= now) {
    uploadRequests.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  current.count += 1;
  return current.count > 10;
}

router.post("/recruitment/uploads", async (req, res): Promise<void> => {
  cleanupRecruitmentRetention().catch((error) => {
    req.log.warn({ err: error }, "Recruitment retention cleanup could not complete");
  });
  if (uploadRateLimited(req.ip || "unknown")) {
    res.status(429).json({ error: "Too many upload attempts. Please wait and try again." });
    return;
  }
  const parsed = RequestRecruitmentUploadBody.safeParse(req.body);
  if (!parsed.success || !validExtension(parsed.data.name, parsed.data.contentType)) {
    res.status(400).json({ error: "Upload a PDF, DOC, or DOCX file no larger than 5 MB." });
    return;
  }
  try {
    const upload = await createRecruitmentUpload(parsed.data.name);
    await db.insert(recruitmentUploadsTable).values({ objectPath: upload.objectPath });
    res.status(201).json(RequestRecruitmentUploadResponse.parse(upload));
  } catch (error) {
    req.log.error({ err: error }, "Failed to create recruitment upload URL");
    res.status(503).json({ error: "CV storage is temporarily unavailable. Please try again." });
  }
});

router.post("/recruitment/applications", async (req, res): Promise<void> => {
  cleanupRecruitmentRetention().catch((error) => {
    req.log.warn({ err: error }, "Recruitment retention cleanup could not complete");
  });
  const parsed = SubmitRecruitmentApplicationBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.consent || parsed.data.website) {
    res.status(400).json({ error: "Please provide valid application details and consent." });
    return;
  }
  const input = parsed.data;
  if (!validExtension(input.cvFileName, input.cvContentType) || input.cvSize > MAX_SIZE) {
    res.status(400).json({ error: "The selected CV file is not supported." });
    return;
  }

  const emailNormalized = input.email.trim().toLowerCase();
  const [existing] = await db.select({ id: recruitmentApplicationsTable.id })
    .from(recruitmentApplicationsTable)
    .where(eq(recruitmentApplicationsTable.emailNormalized, emailNormalized))
    .limit(1);
  if (existing) {
    try {
      await deleteRecruitmentUpload(input.cvObjectPath);
      await db.delete(recruitmentUploadsTable)
        .where(eq(recruitmentUploadsTable.objectPath, input.cvObjectPath));
    } catch (error) {
      req.log.warn({ err: error }, "Could not remove duplicate recruitment upload");
    }
    res.status(409).json({ error: "An application from this email address has already been received." });
    return;
  }

  try {
    const [pendingUpload] = await db.select({ id: recruitmentUploadsTable.id })
      .from(recruitmentUploadsTable)
      .where(eq(recruitmentUploadsTable.objectPath, input.cvObjectPath))
      .limit(1);
    if (!pendingUpload) {
      res.status(400).json({ error: "The CV upload session has expired. Please select the file again." });
      return;
    }

    const uploaded = await inspectRecruitmentUpload(input.cvObjectPath);
    if (!uploaded || uploaded.size !== input.cvSize || uploaded.size > MAX_SIZE || uploaded.contentType !== input.cvContentType) {
      if (uploaded) {
        await deleteRecruitmentUpload(input.cvObjectPath);
        await db.delete(recruitmentUploadsTable)
          .where(eq(recruitmentUploadsTable.objectPath, input.cvObjectPath));
      }
      res.status(400).json({ error: "The CV upload could not be verified. Please select the file again." });
      return;
    }

    const application = await db.transaction(async (tx) => {
      const [saved] = await tx.insert(recruitmentApplicationsTable).values({
        name: input.name.trim(),
        email: input.email.trim(),
        emailNormalized,
        details: input.details.trim(),
        consent: true,
        cvObjectPath: input.cvObjectPath,
        cvFileName: input.cvFileName,
        cvContentType: input.cvContentType,
        cvSize: input.cvSize,
        notificationStatus: "not_required",
      }).returning();
      await tx.delete(recruitmentUploadsTable)
        .where(eq(recruitmentUploadsTable.objectPath, input.cvObjectPath));
      return saved;
    });

    res.status(201).json(SubmitRecruitmentApplicationResponse.parse({
      id: application.id,
      status: "received",
    }));
  } catch (error) {
    const databaseError = error as { code?: string };
    if (databaseError.code === "23505") {
      res.status(409).json({ error: "This application or CV has already been received." });
      return;
    }
    req.log.error({ err: error }, "Failed to submit recruitment application");
    res.status(500).json({ error: "We could not save the application. Please try again." });
  }
});

export default router;