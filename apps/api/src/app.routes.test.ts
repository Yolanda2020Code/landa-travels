import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  chatbotEventsTable,
  conversationsTable,
  conversationTurnsTable,
  db,
} from "@workspace/db";
import { emptyTripContext } from "./services/eco-travel";
import { createApp } from "./app";
import { eq } from "drizzle-orm";

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("an app without Clerk keys serves health and keeps protected GET and POST routes closed", async (t) => {
  const { server, baseUrl } = await listen(createApp(null));
  t.after(() => close(server));

  const health = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const headers = { "x-user-id": "client-supplied-user", "x-clerk-user-id": "client-supplied-user" };
  const protectedGet = await fetch(`${baseUrl}/api/trips`, { headers });
  assert.equal(protectedGet.status, 401);

  const protectedPost = await fetch(`${baseUrl}/api/trips`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "Untrusted identity" }),
  });
  assert.equal(protectedPost.status, 401);
});

test("the public assistant route works without Clerk keys when Rasa is reachable", async (t) => {
  const sessionId = `keyless-assistant-${Date.now()}`;
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  const { server, baseUrl } = await listen(createApp(null));
  t.after(() => close(server));

  try {
    process.env.RASA_URL = "http://keyless-rasa.test";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/webhooks/rest/webhook")) {
        return new Response(JSON.stringify([{ text: "Anonymous planning is available." }]), { status: 200 });
      }
      if (url.pathname.endsWith("/tracker")) {
        return new Response(JSON.stringify({ slots: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const response = await previousFetch(`${baseUrl}/api/assistant/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: "Help me plan", context: emptyTripContext }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json() as { messages: string[] }).messages,
      ["Anonymous planning is available."],
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});