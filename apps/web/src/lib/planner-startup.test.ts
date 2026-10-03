import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const planner = readFileSync(new URL("../pages/planner.tsx", import.meta.url), "utf8");

test("fresh sessions greet through Rasa without putting Hello in the composer", () => {
  assert.match(planner, /payload: restored \? "\/resume_trip" : "\/greet"/);
  assert.match(planner, /if \(!automatic\) setMessages/);
  assert.match(planner, /useState\(""\)/);
  assert.match(planner, /data-testid="planner-welcome"/);
});

test("automatic greeting waits for scoped hydration and does not reset restored trips", () => {
  assert.match(planner, /!hydrated \|\| !resumeResolved \|\| resumeInvalid/);
  assert.match(planner, /greetedSession\.current === sessionId/);
  assert.match(planner, /data-testid="planner-ai-disclosure"/);
  assert.match(planner, /AI travel assistant/);
  assert.match(planner, /messages\.length === 0 && hydrated && resumeResolved && !resumeInvalid/);
});