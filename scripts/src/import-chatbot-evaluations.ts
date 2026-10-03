import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, evaluationRunsTable, evaluationPredictionsTable } from "@workspace/db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sources = [
  ["rasa-nlu-held-out-current", "rasa-bot/evidence/nlu-held-out-current/intent_report.json", "intent"],
  ["rasa-core-current", "rasa-bot/evidence/core-current/story_report.json", "action"],
  ["rasa-runtime-current", "rasa-bot/evidence/runtime-current.json", "intent"],
] as const;

function aggregatePredictions(runKey: string, taskType: string, artifact: Record<string, any>) {
  if (taskType === "intent" && artifact.smoke_metrics?.predictions) {
    return artifact.smoke_metrics.predictions.map((prediction: any, index: number) => ({
      sampleKey: `${runKey}:runtime:${String(index).padStart(4, "0")}`,
      taskType, expected: prediction.expected_intent ?? null, predicted: prediction.predicted_intent ?? null,
      confidence: prediction.confidence == null ? null : String(prediction.confidence), entities: prediction.entities ?? [],
    }));
  }
  return Object.entries(artifact).flatMap(([expected, report]: [string, any]) => {
    if (["macro avg", "weighted avg", "micro avg", "accuracy", "conversation_accuracy"].includes(expected)) return [];
    if (!report || typeof report.support !== "number") return [];
    const confused = report.confused_with ?? {};
    const diagonal = Math.max(0, report.support - Object.values(confused as Record<string, number>).reduce((sum: number, count: number) => sum + Number(count), 0));
    const pairs = [{ predicted: expected, count: diagonal }, ...Object.entries(confused).map(([predicted, count]) => ({ predicted, count: Number(count) }))];
    return pairs.flatMap(({ predicted, count }) => Array.from({ length: count }, (_, index) => ({
      sampleKey: `${runKey}:aggregate:${encodeURIComponent(expected)}:${encodeURIComponent(predicted)}:${String(index).padStart(4, "0")}`,
      taskType, expected, predicted, confidence: null, entities: [],
    })));
  });
}

await db.transaction(async (tx) => {
  for (const [runKey, relative, taskType] of sources) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const artifact = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    const metrics = artifact["weighted avg"] ?? artifact.smoke_metrics ?? {};
    const [run] = await tx.insert(evaluationRunsTable).values({
      runKey, datasetVersion: relative, modelVersion: artifact.environment?.model ?? "task12-current",
      command: artifact.command ?? `rasa test ${taskType}`, evaluationType: "labelled_evaluation", metrics, artifact,
    }).onConflictDoUpdate({ target: evaluationRunsTable.runKey, set: { metrics, artifact } }).returning();
    await tx.delete(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runId, run.id));
    const predictions = aggregatePredictions(runKey, taskType, artifact);
    if (predictions.length) await tx.insert(evaluationPredictionsTable).values(predictions.map((prediction: any) => ({ runId: run.id, ...prediction })));
  }
});