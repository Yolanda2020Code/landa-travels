import assert from "node:assert/strict";
import test from "node:test";
import { explicitClerkProxyUrl, explicitPublishableKeyFromHost } from "./clerk-key";

const configuredKey = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k";

test("does not derive a Clerk publishable key from any host when configuration is empty", () => {
  assert.equal(explicitPublishableKeyFromHost("localhost", ""), undefined);
  assert.equal(explicitPublishableKeyFromHost("127.0.0.1", undefined), undefined);
  assert.equal(explicitPublishableKeyFromHost("alternate.example.net", undefined), undefined);
  assert.equal(explicitPublishableKeyFromHost("travel-app.hf.space", ""), undefined);
  assert.equal(explicitPublishableKeyFromHost("custom.example.org", undefined), undefined);
});

test("uses an explicit configured key on localhost, IP, Hugging Face, and custom hosts", () => {
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "travel-app.hf.space",
    "custom.example.org",
  ]) {
    assert.equal(explicitPublishableKeyFromHost(hostname, configuredKey), configuredKey);
  }
});

test("preserves explicitly configured keys for alternate hosts", () => {
  for (const hostname of ["alternate.example.net", "alternate.example.org"]) {
    assert.equal(
      explicitPublishableKeyFromHost(hostname, configuredKey),
      configuredKey,
    );
  }
});

test("independent authentication connects directly without an explicit proxy", () => {
  assert.equal(explicitClerkProxyUrl(undefined, undefined), undefined);
  assert.equal(explicitClerkProxyUrl("", undefined), undefined);
});

test("an empty runtime proxy explicitly disables an inherited build proxy", () => {
  assert.equal(explicitClerkProxyUrl("", "https://build.example/api/__clerk"), undefined);
});

test("only an explicitly configured authentication proxy is used", () => {
  assert.equal(explicitClerkProxyUrl(" https://runtime.example/api/__clerk ", undefined),
    "https://runtime.example/api/__clerk");
  assert.equal(explicitClerkProxyUrl(undefined, "https://build.example/api/__clerk"),
    "https://build.example/api/__clerk");
});