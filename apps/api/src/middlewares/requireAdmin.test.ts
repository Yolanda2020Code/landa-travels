import test from "node:test";
import assert from "node:assert/strict";
import { isAdminClaims, isAdvisorClaims } from "./requireAdmin";

test("admin predicate accepts verified role locations", () => {
  assert.equal(isAdminClaims({ role: "admin" }), true);
  assert.equal(isAdminClaims({ metadata: { role: "admin" } }), true);
  assert.equal(isAdminClaims({ publicMetadata: { role: "admin" } }), true);
});

test("admin predicate denies missing or non-admin roles", () => {
  assert.equal(isAdminClaims(undefined), false);
  assert.equal(isAdminClaims({ role: "user" }), false);
  assert.equal(isAdminClaims({ metadata: { role: "owner" } }), false);
});

test("advisor predicate accepts advisor and admin roles but denies travellers", () => {
  assert.equal(isAdvisorClaims({ role: "advisor" }), true);
  assert.equal(isAdvisorClaims({ metadata: { role: "advisor" } }), true);
  assert.equal(isAdvisorClaims({ publicMetadata: { role: "admin" } }), true);
  assert.equal(isAdvisorClaims({ role: "traveller" }), false);
});