import test from "node:test";
import assert from "node:assert/strict";
import { isAdminClaims, isAdvisorClaims, verifiedBackendRole } from "./requireAdmin";

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

test("backend role lookup trusts public metadata and encodes the verified identity", async () => {
  let requested = "";
  const request = async (url: string | URL | Request) => {
    requested = String(url);
    return Response.json({ public_metadata: { role: "admin" } });
  };
  assert.equal(await verifiedBackendRole("synthetic/user", "admin", "synthetic-secret", request as typeof fetch), true);
  assert.equal(requested, "https://api.clerk.com/v1/users/synthetic%2Fuser");
});

test("backend roles deny unsafe metadata and separate advisor from administrator", async () => {
  const unsafe = (async () => Response.json({ unsafe_metadata: { role: "admin" } })) as typeof fetch;
  const advisor = (async () => Response.json({ public_metadata: { role: "advisor" } })) as typeof fetch;
  assert.equal(await verifiedBackendRole("synthetic", "admin", "synthetic-secret", unsafe), false);
  assert.equal(await verifiedBackendRole("synthetic", "admin", "synthetic-secret", advisor), false);
  assert.equal(await verifiedBackendRole("synthetic", "advisor", "synthetic-secret", advisor), true);
});

test("backend verification fails closed on unavailable or removed identities", async () => {
  const missing = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const failed = (async () => new Response(null, { status: 503 })) as typeof fetch;
  assert.equal(await verifiedBackendRole("synthetic", "admin", "synthetic-secret", missing), false);
  await assert.rejects(verifiedBackendRole("synthetic", "admin", "synthetic-secret", failed));
});