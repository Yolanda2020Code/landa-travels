import assert from "node:assert/strict";
import test from "node:test";
import { hasVerifiedOwnerEmail } from "./requireRecruitmentOwner";

test("only a verified matching email receives recruitment owner access", () => {
  assert.equal(hasVerifiedOwnerEmail({
    email_addresses: [{ email_address: "owner@example.com", verification: { status: "verified" } }],
  }, " OWNER@example.com "), true);
  assert.equal(hasVerifiedOwnerEmail({
    email_addresses: [{ email_address: "owner@example.com", verification: { status: "unverified" } }],
  }, "owner@example.com"), false);
  assert.equal(hasVerifiedOwnerEmail({
    email_addresses: [{ email_address: "other@example.com", verification: { status: "verified" } }],
  }, "owner@example.com"), false);
});