import app from "./app";
import { logger } from "./lib/logger";
import { startCertificationRegistryRefresh } from "./services/certification-registry";
import { startChatbotRetentionMaintenance } from "./services/chatbot-retention";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);
startCertificationRegistryRefresh();

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

startChatbotRetentionMaintenance();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
