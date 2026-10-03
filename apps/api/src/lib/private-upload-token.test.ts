import test from "node:test";
import assert from "node:assert/strict";
import { issueFileCapability, verifyFileCapability, validCvBytes, validPrivatePath } from "./private-upload-token";

const secret = "synthetic-test-signing-key-32-characters";
const path = "/objects/recruitment/12345678-1234-1234-1234-123456789abc/cv.pdf";
test("file capabilities are method-bound, signed, and time-limited", () => {
  const token = issueFileCapability(path, "PUT", secret, 1000);
  assert.equal(verifyFileCapability(token, "PUT", secret, 1001)?.path, path);
  assert.equal(verifyFileCapability(token, "GET", secret, 1001), null);
  assert.equal(verifyFileCapability(token, "PUT", secret + "x", 1001), null);
  assert.equal(verifyFileCapability(token, "PUT", secret, 902_000), null);
  assert.equal(verifyFileCapability(token + "x", "PUT", secret, 1001), null);
});
test("private paths reject traversal and non-CV bytes are rejected", () => {
  assert.equal(validPrivatePath(path), true);
  assert.equal(validPrivatePath(path.replace("cv.pdf", "../cv.pdf")), false);
  assert.equal(validCvBytes(Buffer.from("%PDF-1.7 synthetic"), "application/pdf"), true);
  assert.equal(validCvBytes(Buffer.from("<html>not a PDF</html>"), "application/pdf"), false);
  assert.equal(validCvBytes(Buffer.alloc(5 * 1024 * 1024 + 1), "application/pdf"), false);
});