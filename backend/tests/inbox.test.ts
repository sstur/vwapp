import { describe, expect, it } from "vitest";
import { legacyInboxMatch } from "../src/inbox";

describe("Android inbox migration", () => {
  const legacy = {
    messageId: "vw-id",
    title: "VW Care\n",
    body: "<p>Care &amp; maintenance<br>for your vehicle.</p>",
    readOverride: true,
    deletedAt: 123,
  };
  const incoming = {
    id: "android:hash",
    title: "VW Care",
    body: "Care & maintenance for your vehicle.",
  };
  it("recognizes rendered HTML content and retains the row owning user overrides", () => {
    expect(legacyInboxMatch([legacy], incoming)).toBe(legacy);
  });
  it("does not merge different Android IDs or new content into an older message", () => {
    expect(
      legacyInboxMatch(
        [{ ...legacy, messageId: "android:older-hash" }],
        incoming,
      ),
    ).toBeUndefined();
    expect(
      legacyInboxMatch([legacy], { ...incoming, body: "A different offer" }),
    ).toBeUndefined();
  });
  it("declines ambiguous legacy matches", () => {
    expect(
      legacyInboxMatch(
        [legacy, { ...legacy, messageId: "another-vw-id" }],
        incoming,
      ),
    ).toBeUndefined();
  });
});
