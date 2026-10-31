import assert from "node:assert/strict";
import test from "node:test";
import { protectNames, restoreNames } from "../src/shared/glossary";
import { connectionState } from "../src/shared/protocol";
import { MockProvider } from "../src/server/providers/mock";

test("place names survive translation and Side stays case-sensitive", async () => {
  const glossary = ["Hagia Sophia", "Kaymaklı", "Derinkuyu", "Aspendos", "Side"];
  const source = "Tomorrow we visit Side, Aspendos, Kaymaklı and Derinkuyu.";
  const masked = protectNames(source, glossary);
  assert.equal(masked.text.includes("Side"), false);
  assert.equal(masked.text.includes("side"), false);
  assert.match(protectNames("Walk side by side.", glossary).text, /side by side/);

  const provider = new MockProvider();
  const result = await provider.translate(source, "de", glossary);
  assert.match(result.text, /Side/);
  assert.match(result.text, /Aspendos/);
  assert.match(result.text, /Kaymaklı/);
  assert.match(result.text, /Derinkuyu/);
  assert.match(result.text, /Morgen/);
  assert.doesNotMatch(result.text, /Seite/);
  assert.doesNotMatch(result.text, /⟦/);
  assert.equal(restoreNames("Hello ⟦N0⟧", [{ token: "⟦N0⟧", term: "Side" }]), "Hello Side");
});

test("link status treats a slow sentence as lagging and an early stream as connected", () => {
  assert.equal(connectionState({ online: false }), "offline");
  assert.equal(connectionState({ online: true, lastPipelineMs: 4200 }), "lagging");
  assert.equal(connectionState({ online: true, rttMs: 900 }), "lagging");
  assert.equal(connectionState({ online: true, lastPipelineMs: 0, early: true, rttMs: 40 }), "connected");
  assert.equal(connectionState({ online: true, lastPipelineMs: 800, rttMs: 40 }), "connected");
});
