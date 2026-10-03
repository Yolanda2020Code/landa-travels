import test from "node:test";
import assert from "node:assert/strict";
import { getClerkProxyUrl } from "./clerkProxyMiddleware";

test("the configured HTTPS public origin overrides internal HTTP proxy headers", () => {
  const previous = process.env.PUBLIC_APP_URL;
  try {
    process.env.PUBLIC_APP_URL = "https://assessment.example";
    assert.equal(getClerkProxyUrl({ headers: { host: "internal.example", "x-forwarded-proto": "http" } }),
      "https://assessment.example/api/__clerk");
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
});

test("fallback proxy protocols use the first forwarded value", () => {
  const previous = process.env.PUBLIC_APP_URL;
  try {
    delete process.env.PUBLIC_APP_URL;
    assert.equal(getClerkProxyUrl({ headers: { host: "assessment.example", "x-forwarded-proto": "https, http" } }),
      "https://assessment.example/api/__clerk");
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
});