import test from "node:test";
import assert from "node:assert/strict";
import { didAuthenticatedUserChange } from "./auth-cache";

test("does not clear the cache while Clerk establishes the initial session", () => {
  assert.equal(didAuthenticatedUserChange(undefined, null), false);
  assert.equal(didAuthenticatedUserChange(undefined, "user-a"), false);
});

test("clears user-scoped cache on sign-in, sign-out, and account switches", () => {
  assert.equal(didAuthenticatedUserChange(null, "user-a"), true);
  assert.equal(didAuthenticatedUserChange("user-a", null), true);
  assert.equal(didAuthenticatedUserChange("user-a", "user-b"), true);
  assert.equal(didAuthenticatedUserChange("user-a", "user-a"), false);
});