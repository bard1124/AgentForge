import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal, total } from "./cart.js";

const items = [{ price: 20, qty: 2 }, { price: 10, qty: 1 }];

test("subtotal", () => assert.equal(subtotal(items), 50));
test("no code", () => assert.equal(total(items), 50));
test("SAVE10 takes 10% off", () => assert.equal(total(items, "SAVE10"), 45));
test("FLAT5 takes 5 off", () => assert.equal(total(items, "FLAT5"), 45));
