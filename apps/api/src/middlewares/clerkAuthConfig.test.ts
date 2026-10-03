import assert from "node:assert/strict";
import test from "node:test";
import { clerkPublishableKeyForHost, getConfiguredClerkCredentials } from "./clerkAuthConfig";

test("server Clerk auth is disabled without both valid matching configured keys", () => {
  assert.equal(getConfiguredClerkCredentials({}), null);
  assert.equal(
    getConfiguredClerkCredentials({
      CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
    }),
    null,
  );
  assert.equal(
    getConfiguredClerkCredentials({
      CLERK_PUBLISHABLE_KEY: "not-a-publishable-key",
      CLERK_SECRET_KEY: "not-a-secret-key",
    }),
    null,
  );
  assert.equal(
    getConfiguredClerkCredentials({
      CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k",
      CLERK_SECRET_KEY: "sk_test_configured",
    }),
    null,
  );
});

test("server Clerk auth accepts a configured matching key pair", () => {
  assert.deepEqual(
    getConfiguredClerkCredentials({
      CLERK_PUBLISHABLE_KEY: " pk_test_Y2xlcmsuZXhhbXBsZS5jb20k ",
      CLERK_SECRET_KEY: " sk_test_configured ",
    }),
    {
      publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
      secretKey: "sk_test_configured",
    },
  );
});

test("a configured Clerk publishable key is preserved on localhost and custom hosts", () => {
  const configuredKey = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k";
  for (const host of [
    "localhost",
    "127.0.0.1:3000",
    "travel-app.hf.space",
    "custom.example.org",
  ]) {
    assert.equal(clerkPublishableKeyForHost(host, configuredKey), configuredKey);
  }
});

test("server preserves explicitly configured keys for alternate hosts", () => {
  const configuredKey = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k";
  for (const host of ["alternate.example.net", "alternate.example.org"]) {
    assert.equal(
      clerkPublishableKeyForHost(host, configuredKey),
      configuredKey,
    );
  }
});