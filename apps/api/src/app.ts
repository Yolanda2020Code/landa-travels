import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import {
  clerkPublishableKeyForHost,
  getConfiguredClerkCredentials,
  type ClerkCredentials,
} from "./middlewares/clerkAuthConfig";

export function createApp(clerkCredentials: ClerkCredentials | null = getConfiguredClerkCredentials()): Express {
  const app: Express = express();
  app.locals.clerkAuthEnabled = clerkCredentials !== null;

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0]?.replace(/\/recruitment\/files\/[^/]+/g, "/recruitment/files/[REDACTED]"),
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
  if (clerkCredentials) {
    app.use(
      clerkMiddleware((req) => ({
        publishableKey: clerkPublishableKeyForHost(
          getClerkProxyHost(req) ?? "",
          clerkCredentials.publishableKey,
        ),
      })),
    );
  }
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", router);

  return app;
}

const app = createApp();
export default app;
