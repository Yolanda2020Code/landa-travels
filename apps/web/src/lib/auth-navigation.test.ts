import assert from "node:assert/strict";
import test from "node:test";
import { isEmbeddedWindow } from "./auth-navigation";

test("a normal browser tab does not require leaving a frame", () => {
  const tab = {};
  assert.equal(isEmbeddedWindow({ self: tab, top: tab }), false);
});

test("embedded previews must open authentication outside their frame", () => {
  assert.equal(isEmbeddedWindow({ self: {}, top: {} }), true);
});

test("server rendering does not access browser globals", () => {
  assert.equal(isEmbeddedWindow(undefined), false);
});

test("restricted access to the parent is treated as an embedded context", () => {
  assert.equal(isEmbeddedWindow({
    self: {},
    get top(): unknown { throw new Error("Restricted parent"); },
  }), true);
});