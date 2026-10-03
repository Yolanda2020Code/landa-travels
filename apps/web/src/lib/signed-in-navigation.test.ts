import assert from "node:assert/strict";
import test from "node:test";
import { getRoleAccountLinks } from "./signed-in-navigation";

test("travellers only see destinations they can access", () => {
  assert.deepEqual(
    getRoleAccountLinks("traveller").map((link) => link.href),
    ["/dashboard", "/bookings", "/rewards"],
  );
});

test("advisors see the advisor inbox but not admin quality control", () => {
  assert.deepEqual(
    getRoleAccountLinks("advisor").map((link) => link.href),
    ["/dashboard", "/bookings", "/rewards", "/advisor"],
  );
});

test("admins retain desktop access to quality control", () => {
  assert.deepEqual(
    getRoleAccountLinks("admin").map((link) => link.href),
    ["/dashboard", "/bookings", "/rewards", "/advisor", "/admin/chatbot-quality"],
  );
});