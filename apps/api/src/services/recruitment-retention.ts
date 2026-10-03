import { eq, lt } from "drizzle-orm";
import { db, recruitmentApplicationsTable, recruitmentUploadsTable } from "@workspace/db";
import { deleteRecruitmentUpload } from "../lib/recruitment-storage";

let nextCleanupAt = 0;

export async function cleanupRecruitmentRetention() {
  const now = new Date();
  if (now.getTime() < nextCleanupAt) return;
  nextCleanupAt = now.getTime() + 60 * 60 * 1000;

  const expired = await db.select({
    id: recruitmentApplicationsTable.id,
    cvObjectPath: recruitmentApplicationsTable.cvObjectPath,
  })
    .from(recruitmentApplicationsTable)
    .where(lt(recruitmentApplicationsTable.retentionExpiresAt, now))
    .limit(100);

  const abandoned = await db.select({
    id: recruitmentUploadsTable.id,
    objectPath: recruitmentUploadsTable.objectPath,
  })
    .from(recruitmentUploadsTable)
    .where(lt(recruitmentUploadsTable.expiresAt, now))
    .limit(100);

  const failures: unknown[] = [];
  for (const application of expired) {
    try {
      await deleteRecruitmentUpload(application.cvObjectPath);
      await db.delete(recruitmentApplicationsTable)
        .where(eq(recruitmentApplicationsTable.id, application.id));
    } catch (error) {
      failures.push(error);
    }
  }
  for (const upload of abandoned) {
    try {
      await deleteRecruitmentUpload(upload.objectPath);
      await db.delete(recruitmentUploadsTable)
        .where(eq(recruitmentUploadsTable.id, upload.id));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    nextCleanupAt = Date.now() + 5 * 60 * 1000;
    throw new AggregateError(failures, "Some recruitment files could not be removed and remain queued for retry.");
  }
}