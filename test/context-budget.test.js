import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS,
  CUSTOMER_CHARS,
  DOCUMENTS_CHARS,
  GROUNDING_CHARS,
  MAX_CUSTOMER_TEXT_CHARS,
  PROFILE_CHARS,
  PROFILE_MAX_DOCUMENTS,
  profileOverflow,
  profileRoom,
} from "../src/shared/context-budget.js";
import { MAX_DOCUMENT_CHARS } from "../src/desktop/grounding-document.js";

/**
 * One place for the numbers the desktop stores and the server pipeline must
 * agree on. The grounding document and the customer profile are loaded whole
 * (never trimmed per question), so together they must fit what is left of the
 * provider's context once every other section has taken its fixed share.
 */
test("the budget constants are the agreed numbers and relate to each other", () => {
  assert.equal(CONTEXT_CHARS, 32_000, "matches the answerer's MAX_CONTEXT_CHARS and the pipeline's CONTEXT_CHARS");
  assert.equal(DOCUMENTS_CHARS, 26_000, "grounding + profile together, after the fixed sections' reserve");
  assert.equal(PROFILE_CHARS, 14_000);
  assert.equal(PROFILE_MAX_DOCUMENTS, 3);
  assert.equal(GROUNDING_CHARS, 12_000);
  assert.equal(GROUNDING_CHARS, MAX_DOCUMENT_CHARS, "the grounding store's cap is the budget's cap");
  assert.equal(GROUNDING_CHARS + PROFILE_CHARS, DOCUMENTS_CHARS, "both at their caps fill the shared budget exactly, so neither is ever trimmed");
  assert.ok(PROFILE_CHARS < DOCUMENTS_CHARS);
  assert.ok(DOCUMENTS_CHARS < CONTEXT_CHARS);
  // The wire and pipeline cap for the rendered profile: one number, so what the
  // server accepts the pipeline keeps whole, and it holds a full profile with
  // the longest possible `File:` labels.
  assert.equal(CUSTOMER_CHARS, 15_000);
  assert.equal(MAX_CUSTOMER_TEXT_CHARS, 14_000 + 3 * (8 + 255) + 2 * 2);
  assert.ok(MAX_CUSTOMER_TEXT_CHARS <= CUSTOMER_CHARS, "a profile at its cap always fits on the wire");
  assert.ok(CUSTOMER_CHARS < DOCUMENTS_CHARS);
  for (const value of [CONTEXT_CHARS, DOCUMENTS_CHARS, GROUNDING_CHARS, PROFILE_CHARS, PROFILE_MAX_DOCUMENTS]) {
    assert.ok(Number.isInteger(value) && value > 0);
  }
});

test("profileRoom is what a profile may still take: its own cap or the shared budget, whichever bites first", () => {
  assert.equal(profileRoom(), PROFILE_CHARS, "no grounding document, empty profile");
  assert.equal(profileRoom({ groundingChars: 0, profileChars: 4_000 }), 10_000);
  assert.equal(profileRoom({ groundingChars: 10_000, profileChars: 0 }), PROFILE_CHARS, "grounding leaves 16,000; the profile cap is lower");
  assert.equal(profileRoom({ groundingChars: 20_000, profileChars: 0 }), 6_000, "the shared budget bites first");
  assert.equal(profileRoom({ groundingChars: 20_000, profileChars: 5_000 }), 1_000);
  assert.equal(profileRoom({ groundingChars: 12_000, profileChars: 0 }), PROFILE_CHARS, "a full-size grounding document still leaves the whole profile cap");
  assert.equal(profileRoom({ groundingChars: 26_000, profileChars: 0 }), 0, "an oversized grounding document (an older build's file) leaves no room");
  assert.equal(profileRoom({ groundingChars: 0, profileChars: 14_000 }), 0);
  assert.equal(profileRoom({ groundingChars: 0, profileChars: 20_000 }), 0, "never negative");
});

test("profileOverflow names the limit a new document would break, or null when it fits", () => {
  assert.equal(profileOverflow({ groundingChars: 0, profileChars: 0, addChars: 14_000 }), null, "exactly the cap fits");
  assert.equal(profileOverflow({ groundingChars: 12_000, profileChars: 0, addChars: 14_000 }), null, "26,000 together fits");
  assert.deepEqual(profileOverflow({ groundingChars: 0, profileChars: 0, addChars: 14_001 }), {
    limit: "profile",
    max: PROFILE_CHARS,
    total: 14_001,
  });
  assert.deepEqual(profileOverflow({ groundingChars: 0, profileChars: 7_000, addChars: 7_001 }), {
    limit: "profile",
    max: PROFILE_CHARS,
    total: 14_001,
  });
  assert.deepEqual(profileOverflow({ groundingChars: 20_000, profileChars: 5_000, addChars: 1_001 }), {
    limit: "documents",
    max: DOCUMENTS_CHARS,
    total: 26_001,
  });
  assert.equal(profileOverflow({ groundingChars: 20_000, profileChars: 5_000, addChars: 1_000 }), null);
  // Both limits broken: the profile's own cap is the one the rep can act on first.
  assert.equal(profileOverflow({ groundingChars: 26_000, profileChars: 14_000, addChars: 1 }).limit, "profile");
  assert.equal(profileOverflow({ groundingChars: 26_000, profileChars: 0, addChars: 1 }).limit, "documents");
});

test("missing or malformed numbers count as zero", () => {
  assert.equal(profileRoom({}), PROFILE_CHARS);
  assert.equal(profileRoom({ groundingChars: "lots", profileChars: null }), PROFILE_CHARS);
  assert.equal(profileOverflow({ addChars: 1 }), null);
  assert.equal(profileOverflow({ groundingChars: NaN, profileChars: -5, addChars: PROFILE_CHARS }), null);
});
