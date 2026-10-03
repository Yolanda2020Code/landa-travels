import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const CLERK_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";

export function getClerkProxyHost(req: { headers: IncomingHttpHeaders }): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return raw?.split(",")[0]?.trim() || req.headers.host?.trim() || undefined;
}

export function getClerkProxyUrl(req: { headers: IncomingHttpHeaders }): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) {
    const origin = new URL(configured);
    if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) {
      throw new Error("The public authentication origin must use HTTPS.");
    }
    return `${origin.origin}${CLERK_PROXY_PATH}`;
  }
  const raw = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim() === "http" ? "http" : "https";
  return `${protocol}://${getClerkProxyHost(req) || ""}${CLERK_PROXY_PATH}`;
}

export function clerkProxyMiddleware(): RequestHandler {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (process.env.NODE_ENV !== "production" || !secretKey) {
    return (_req, _res, next) => next();
  }
  return createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (path: string) => path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ""),
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader("Clerk-Proxy-Url", getClerkProxyUrl(req));
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);
        const forwarded = req.headers["x-forwarded-for"];
        const clientIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || req.socket.remoteAddress;
        if (clientIp) proxyReq.setHeader("X-Forwarded-For", clientIp);
      },
      proxyRes: (proxyRes, req, res) => {
        const headers = { ...proxyRes.headers };
        delete headers["transfer-encoding"];
        delete headers.connection;
        delete headers["keep-alive"];
        const status = proxyRes.statusCode ?? 502;
        const bodyless = req.method === "HEAD" || status < 200 || status === 204 || status === 304;
        if (headers["content-length"] !== undefined || bodyless) {
          res.writeHead(status, headers);
          proxyRes.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks);
          headers["content-length"] = String(body.length);
          res.writeHead(status, headers);
          res.end(body);
        });
        proxyRes.on("error", () => res.destroy());
      },
    },
  }) as RequestHandler;
}