import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const travellerProfilesTable = pgTable("traveller_profiles", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  displayName: text("display_name").notNull().default("Traveller"),
  homeBase: text("home_base"),
  bio: text("bio"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const savedTripsTable = pgTable("saved_trips", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  origin: text("origin"),
  destination: text("destination"),
  dateRange: text("date_range"),
  travellerCount: integer("traveller_count"),
  budget: text("budget"),
  sustainabilityPriority: text("sustainability_priority"),
  context: jsonb("context").notNull().default({}),
  status: text("status").notNull().default("planning"),
  conversationSessionId: text("conversation_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const advisorHandoversTable = pgTable("advisor_handovers", {
  id: serial("id").primaryKey(),
  handoverId: text("handover_id").notNull().unique(),
  userId: text("user_id"),
  savedTripId: integer("saved_trip_id").references(() => savedTripsTable.id, { onDelete: "cascade" }),
  guestSessionId: text("guest_session_id").references(() => conversationsTable.sessionId, { onDelete: "cascade" }),
  contactEmail: text("contact_email"),
  replyNotificationStatus: text("reply_notification_status").notNull().default("not_requested"),
  status: text("status").notNull().default("requested"),
  summary: text("summary").notNull(),
  privacyContext: jsonb("privacy_context").notNull().default({}),
  transcript: jsonb("transcript").notNull().default([]),
  travellerReply: text("traveller_reply"),
  assignedAdvisorId: text("assigned_advisor_id"),
  assignedAdvisorName: text("assigned_advisor_name"),
  notificationStatus: text("notification_status").notNull().default("pending"),
  notificationError: text("notification_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("advisor_handovers_guest_session_unique").on(table.guestSessionId).where(sql`${table.guestSessionId} IS NOT NULL`),
]);

export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  userId: text("user_id"),
  context: jsonb("context").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '30 days'`),
});

export const conversationTurnsTable = pgTable("conversation_turns", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => conversationsTable.sessionId, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  redactedContent: text("redacted_content"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatbotEventsTable = pgTable("chatbot_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique("chatbot_events_event_id_key"),
  sessionId: text("session_id").notNull(),
  turnId: integer("turn_id"),
  eventType: text("event_type").notNull(),
  source: text("source").notNull().default("demo"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  latencyMs: integer("latency_ms"),
  confidence: text("confidence"),
  payload: jsonb("payload").notNull().default({}),
});

export const evaluationRunsTable = pgTable("chatbot_evaluation_runs", {
  id: serial("id").primaryKey(),
  runKey: text("run_key").notNull().unique(),
  datasetVersion: text("dataset_version").notNull(),
  modelVersion: text("model_version"),
  command: text("command").notNull(),
  evaluationType: text("evaluation_type").notNull().default("labelled_evaluation"),
  metrics: jsonb("metrics").notNull().default({}),
  artifact: jsonb("artifact").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evaluationPredictionsTable = pgTable("chatbot_evaluation_predictions", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => evaluationRunsTable.id, { onDelete: "cascade" }),
  sampleKey: text("sample_key").notNull(),
  taskType: text("task_type").notNull(),
  expected: text("expected"),
  predicted: text("predicted"),
  confidence: text("confidence"),
  entities: jsonb("entities").notNull().default([]),
});

export const chatbotReviewsTable = pgTable("chatbot_reviews", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").references(() => chatbotEventsTable.eventId, { onDelete: "set null" }),
  sessionId: text("session_id").notNull(),
  reviewerId: text("reviewer_id").notNull(),
  label: text("label").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLogTable = pgTable("admin_audit_log", {
  id: serial("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull(),
  action: text("action").notNull(),
  resource: text("resource"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookingRecordsTable = pgTable("booking_records", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  tripId: integer("trip_id").references(() => savedTripsTable.id, { onDelete: "set null" }),
  label: text("label").notNull(),
  bookingType: text("booking_type").notNull(),
  providerReference: text("provider_reference"),
  status: text("status").notNull().default("requested"),
  source: text("source").notNull().default("demo"),
  carbonKg: integer("carbon_kg"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rewardEventsTable = pgTable("reward_events", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  points: integer("points").notNull(),
  reason: text("reason").notNull(),
  evidence: text("evidence").notNull(),
  category: text("category").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactRequestsTable = pgTable("contact_requests", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  message: text("message").notNull(),
  topic: text("topic"),
  consent: boolean("consent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recruitmentApplicationsTable = pgTable("recruitment_applications", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull().unique(),
  details: text("details").notNull(),
  consent: boolean("consent").notNull(),
  cvObjectPath: text("cv_object_path").notNull().unique(),
  cvFileName: text("cv_file_name").notNull(),
  cvContentType: text("cv_content_type").notNull(),
  cvSize: integer("cv_size").notNull(),
  notificationStatus: text("notification_status").notNull().default("not_required"),
  notificationError: text("notification_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '90 days'`),
});

export const recruitmentUploadsTable = pgTable("recruitment_uploads", {
  id: serial("id").primaryKey(),
  objectPath: text("object_path").notNull().unique(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '24 hours'`),
});

export const insertTravellerProfileSchema = createInsertSchema(travellerProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSavedTripSchema = createInsertSchema(savedTripsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBookingRecordSchema = createInsertSchema(bookingRecordsTable).omit({ id: true, createdAt: true });
export const insertRewardEventSchema = createInsertSchema(rewardEventsTable).omit({ id: true, createdAt: true });
export const insertContactRequestSchema = createInsertSchema(contactRequestsTable).omit({ id: true, createdAt: true });
export const insertRecruitmentApplicationSchema = createInsertSchema(recruitmentApplicationsTable).omit({ id: true, createdAt: true, retentionExpiresAt: true });
export const insertConversationSchema = createInsertSchema(conversationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertConversationTurnSchema = createInsertSchema(conversationTurnsTable).omit({ id: true, createdAt: true });
export const insertAdvisorHandoverSchema = createInsertSchema(advisorHandoversTable).omit({ id: true, createdAt: true, updatedAt: true });

export type TravellerProfile = typeof travellerProfilesTable.$inferSelect;
export type SavedTrip = typeof savedTripsTable.$inferSelect;
export type BookingRecord = typeof bookingRecordsTable.$inferSelect;
export type RewardEvent = typeof rewardEventsTable.$inferSelect;
export type ContactRequest = typeof contactRequestsTable.$inferSelect;
export type RecruitmentApplication = typeof recruitmentApplicationsTable.$inferSelect;
export type RecruitmentUpload = typeof recruitmentUploadsTable.$inferSelect;
export type Conversation = typeof conversationsTable.$inferSelect;
export type ConversationTurn = typeof conversationTurnsTable.$inferSelect;
export type AdvisorHandover = typeof advisorHandoversTable.$inferSelect;
export type ChatbotEvent = typeof chatbotEventsTable.$inferSelect;
export type EvaluationRun = typeof evaluationRunsTable.$inferSelect;
export type TripContextRecord = z.infer<typeof insertSavedTripSchema>;