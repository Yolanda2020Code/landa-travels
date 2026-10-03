#!/usr/bin/env node
/** Real Chromium/DOM challenge runner. Never injects application state or calls assistant APIs directly. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const base = process.argv[2]?.replace(/\/$/, "");
const out = process.argv[3];
if (!base || !out) throw new Error("Usage: chatbot-challenge-widget.mjs BASE_URL OUTPUT_DIRECTORY");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "eco-challenge-"));
const chrome = spawn((process.env.CHROME_BIN || "chromium"), [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let debug = "";
chrome.stderr.on("data", (d) => { debug += d; });
async function waitFor(fn, label, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
const endpoint = await waitFor(() => debug.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], "Chrome startup");
const port = new URL(endpoint).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
let sequence = 0;
const pending = new Map();
let turns = [];
const inflight = new Map();
const started = new Map();
const syntheticSessions = new Set();
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
}
socket.onmessage = async ({ data }) => {
  const p = JSON.parse(data);
  if (p.method === "Network.requestWillBeSent" && p.params.request.url.includes("/api/assistant/message")) {
    started.set(p.params.requestId, p.params.timestamp);
    try { syntheticSessions.add(JSON.parse(p.params.request.postData).sessionId); } catch {}
  }
  if (p.id) {
    const entry = pending.get(p.id); pending.delete(p.id);
    if (entry) p.error ? entry.reject(new Error(p.error.message)) : entry.resolve(p.result);
  }
  if (p.method === "Network.responseReceived" && p.params.response.url.includes("/api/assistant/message")) {
    inflight.set(p.params.requestId, { status: p.params.response.status, timing: p.params.response.timing });
  }
  if (p.method === "Network.loadingFinished" && inflight.has(p.params.requestId)) {
    const meta = inflight.get(p.params.requestId); inflight.delete(p.params.requestId);
    try {
      const response = await call("Network.getResponseBody", { requestId: p.params.requestId });
      const body = JSON.parse(response.body);
      turns.push({ status: meta.status, elapsedMs: Math.round((p.params.timestamp - started.get(p.params.requestId)) * 1000), messages: body.messages, context: body.context,
        quickReplies: body.quickReplies, handoverNeeded: body.handoverNeeded, error: body.error,
        recommendations: body.recommendations?.length ?? 0 });
    } catch (e) { turns.push({ status: meta.status, capture_error: String(e) }); }
  }
};
async function evaluate(expression) {
  const value = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result?.value;
}
await call("Page.enable");
await call("Runtime.enable");
await call("Network.enable");
async function fresh() {
  const startTime = Date.now();
  turns = [];
  await call("Page.navigate", { url: `${base}/planner` });
  await waitFor(() => evaluate(`!!document.querySelector('textarea[placeholder="Type your answer or ask a question..."]')`), "chat widget");
  await delay(600);
  await waitFor(() => evaluate(`!document.querySelector('textarea[placeholder="Type your answer or ask a question..."]').disabled`), "ready composer");
  if (process.env.EXPECT_GREETING === "1") {
    await waitFor(() => turns.some((t) => t.messages?.some((m) => /Hello.*AI travel-planning assistant/i.test(m))), "automatic Rasa greeting");
  }
  return Date.now() - startTime;
}
async function send(text) {
  const startTime = Date.now();
  const count = turns.length;
  await evaluate(`(() => {
    const el = document.querySelector('textarea[placeholder="Type your answer or ask a question..."]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(60);
  await evaluate(`document.querySelector('textarea[placeholder="Type your answer or ask a question..."]').closest('form').requestSubmit()`);
  await waitFor(() => turns.length > count, "assistant response", 45000);
  await waitFor(() => evaluate(`!document.querySelector('textarea[placeholder="Type your answer or ask a question..."]').disabled`), "composer enabled");
  const response = turns.at(-1);
  if (response.status === 200 && response.messages?.length) {
    await waitFor(() => evaluate(`(() => {
      const visible = document.body.innerText.replace(/\\s+/g, " ");
      const consent = document.querySelector('[data-testid="checkbox-share-transcript-consent"]');
      if (${JSON.stringify(!!response.context?.handoverRequested)} && consent?.getClientRects().length &&
          !consent.checked && document.querySelector('[data-testid="button-submit-advisor-handover"]')?.disabled) return true;
      return ${JSON.stringify(response.messages)}.every((message) =>
        visible.includes(message.replace(/\\s+/g, " ").slice(0, 70)));
    })()`), "response or consent-gated advisor panel rendered");
    response.visibleElapsedMs = Date.now() - startTime;
  }
  await delay(120);
}
const d = new Date(); d.setDate(d.getDate() + 14); const start = d.toISOString().slice(0, 10);
d.setDate(d.getDate() + 4); const end = d.toISOString().slice(0, 10);
const tests = [
  ["1-typos", ["heyy i wanna go somwhere eco friendlyy"]],
  ["2-single-entity", ["I want to plan a trip from London", "Bali"]],
  ["3-multi-slot-pet", ["I want to travel from London to Costa Rica next week with my dog"]],
  ["4-correction", ["Plan a trip to Iceland", "London", "actually make it Norway"]],
  ["5-budget-clarification", [`Travel from London to Paris from ${start} to ${end} for two adults`, "what do you mean?"]],
  ["6-repeated-no", ["no", "no", "no", "no"]],
  ["7-flight-carbon", ["What's the carbon footprint of flying to Thailand?"]],
  ["8-vegan-hotels", ["Find me vegan hotels"]],
  ["9-mode-comparison", ["Is it better to take train or plane to Paris from London?"]],
  ["10-budget-discovery", ["I have $500, where can I go sustainably?"]],
  ["11-ambiguity", ["Plan a trip to Springfield"]],
  ["12-human-help", ["I would like a human travel advisor"]],
  ["13-screenshot-correction", ["Paris", "No wait England", "I want to come from", "Correct a detail", "@click:Departure city", "England", "Amsterdam"]],
  ["14-origin-edit-preserves-destination", ["Paris", "Amsterdam", "Change departure", "England"]],
];
const results = [];
function assess(name, observed, opening) {
  const text = observed.flatMap((t) => t.messages ?? []).join(" ");
  const last = observed.at(-1)?.context ?? {};
  const checks = [
    ["no HTTP errors", observed.length > 0 && observed.every((t) => t.status === 200)],
    ["automatic AI greeting", opening.includes("your AI travel-planning assistant")],
    ["persistent AI disclosure", opening.includes("AI travel assistant")],
  ];
  const check = (label, passed) => checks.push([label, !!passed]);
  switch (name) {
    case "1-typos": check("typo starts intake without guessed denial", !/Did you mean|not certain/.test(text) && /travel from/.test(text)); break;
    case "2-single-entity": check("single destination fills active slot", last.origin === "London" && last.destination === "Bali"); break;
    case "3-multi-slot-pet":
      check("route and approximate dates retained", last.origin === "London" && last.destination === "Costa Rica" && last.dateRange === "next week");
      check("pet requirement retained and qualified", last.accommodationNeeds?.includes("pet-friendly") && /pet policies|pet and|travelling with a pet/.test(text)); break;
    case "4-correction":
      check("destination corrected; origin preserved", last.origin === "London" && last.destination === "Norway");
      check("date question continues; no false search", last.dateRange === null && /When are you planning/.test(text)); break;
    case "5-budget-clarification":
      check("budget clarification is contextual", /total trip budget/.test(text) && /currency/.test(text));
      check("other values unchanged", last.origin === "London" && last.destination === "Paris" && last.travellerCount === 2); break;
    case "6-repeated-no": check("repeated refusal pauses without forced handover", /paused the questions/.test(text) && !last.handoverRequested); break;
    case "7-flight-carbon": check("missing origin requested, no invented kg", /Where will you fly from/.test(text) && !/\d+(?:\.\d+)?\s*kg/.test(text) && last.destination === "Thailand"); break;
    case "8-vegan-hotels":
      check("vegan preference kept; evidence limitation stated", last.accommodationNeeds?.includes("vegan") && /don't have a verified/.test(text));
      check("no unsupported recommendations", observed.every((t) => !t.recommendations)); break;
    case "9-mode-comparison": check("quantified, qualified modal comparison", /Rail|rail/.test(text) && /Flight|flight/.test(text) && /kg CO₂e/.test(text) && /one passenger/.test(text)); break;
    case "10-budget-discovery": check("budget/currency retained; no guaranteed offer", /500/.test(last.budget ?? "") && /USD|\$/.test(last.budget ?? "") && /can't guarantee/.test(text) && /Which city/.test(text)); break;
    case "11-ambiguity": check("ambiguous place is not silently resolved", /Which Springfield/.test(text) && !last.destination); break;
    case "12-human-help": check("handover offered, not sent without consent", last.handoverRequested && /Nothing has been sent|Nothing is sent until/.test(text)); break;
    case "13-screenshot-correction":
      check("ambiguous England requests a role, not refusal", /leave from England.*travel to England/.test(observed[2]?.messages.join(" ")) && observed[2]?.context.origin === "Paris");
      check("departure fragment requests origin", observed[3]?.quickReplies.some((r) => r.payload === "__planner_slot__:origin") && !observed[3]?.context.origin);
      check("generic correction presents friendly field choices", /Which trip detail/.test(observed[4]?.messages.join(" ")) && !/accommodation_need|travel_dates|transport_preference/.test(observed[4]?.messages.join(" ")));
      check("explicit answers give England to Amsterdam and date question", last.origin === "England" && last.destination === "Amsterdam" &&
        observed.at(-1)?.quickReplies.some((r) => r.payload === "__planner_slot__:travel_dates") &&
        /When are you planning/.test(observed.at(-1)?.messages.join(" ")));
      break;
    case "14-origin-edit-preserves-destination":
      check("origin edit retains chosen destination", observed[3]?.context.destination === "Amsterdam" && !observed[3]?.context.origin);
      check("England is origin not destination", last.origin === "England" && last.destination === "Amsterdam" &&
        observed.at(-1)?.quickReplies.some((r) => r.payload === "__planner_slot__:travel_dates"));
      break;
  }
  return checks.map(([label, passed]) => ({ label, passed }));
}
try {
  for (const [name, prompts] of tests.filter(([name]) => !process.env.CHALLENGE_CASE || name === process.env.CHALLENGE_CASE)) {
    try {
      const greetingVisibleElapsedMs = await fresh();
      const opening = await evaluate("document.body.innerText");
      for (const prompt of prompts) {
        if (prompt.startsWith("@click:")) {
          const count = turns.length;
          const title = prompt.slice(7);
          await evaluate(`(() => {
            const button = [...document.querySelectorAll('button')].find((b) => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(title)});
            if (!button) throw new Error("Missing visible reply button");
            button.click();
          })()`);
          await waitFor(() => turns.length > count, "selected correction response");
          await waitFor(() => evaluate(`!document.querySelector('textarea[placeholder="Type your answer or ask a question..."]').disabled`), "composer enabled");
        } else await send(prompt);
      }
      const visible = await evaluate("document.body.innerText");
      const screenshot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(out, `${name}.png`), Buffer.from(screenshot.data, "base64"));
      const checks = assess(name, turns, opening);
      results.push({ name, prompts, opening, greetingVisibleElapsedMs, turns: structuredClone(turns), visible, checks, passed: checks.every((c) => c.passed) });
      console.log(JSON.stringify({ name, passed: checks.every((c) => c.passed), failed: checks.filter((c) => !c.passed), replies: turns.map((t) => t.messages ?? t.error) }));
    } catch (e) { results.push({ name, prompts, turns: structuredClone(turns), failure: String(e) }); console.log(`${name}: ${e}`); }
    await writeFile(path.join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), tests: results }, null, 2));
  }
  if (results.some((test) => !test.passed)) process.exitCode = 1;
} finally {
  socket.close(); chrome.kill("SIGTERM"); await delay(300); await rm(profile, { recursive: true, force: true });
  // Only remove exact capabilities created in this isolated synthetic browser.
  // Never select conversations by broad timestamps, message text or user IDs.
  if (process.env.CLEANUP_SYNTHETIC === "1") {
    const cleanup = spawnSync("pnpm", ["--filter", "@workspace/api", "exec", "tsx", "--eval", `
      (async () => {
        const { db, conversationsTable, pool } = await import("@workspace/db");
        const { inArray } = await import("drizzle-orm");
        let input = ""; for await (const chunk of process.stdin) input += chunk;
        const ids = JSON.parse(input).filter(Boolean);
        const rows = await db.select().from(conversationsTable).where(inArray(conversationsTable.sessionId, ids));
        for (const row of rows) {
          const namespace = row.context?.rasaConversationId;
          if (namespace) {
            const result = await fetch("http://127.0.0.1:5005/conversations/" + encodeURIComponent(namespace) + "/tracker/events",
              { method: "PUT", headers: { "Content-Type": "application/json" }, body: "[]" });
            if (!result.ok) throw new Error("Synthetic tracker cleanup failed: HTTP " + result.status);
          }
        }
        await db.delete(conversationsTable).where(inArray(conversationsTable.sessionId, ids));
        await pool.end();
        console.log("Removed " + rows.length + " exact synthetic conversations and their native histories.");
      })().catch(e => { console.error(e.message); process.exit(1); });
    `], { input: JSON.stringify([...syntheticSessions]), encoding: "utf8" });
    console.log(cleanup.stdout);
    if (cleanup.status !== 0) { console.error(cleanup.stderr); process.exitCode = 1; }
  }
}