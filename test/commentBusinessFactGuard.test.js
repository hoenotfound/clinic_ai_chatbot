"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { correctVerifiedCommentBusinessReply, verifiedAnswerKind } =
  require("../src/utils/commentBusinessFactGuard");

const config = {
  branches: [{
    name: "Petaling Jaya (PJ)",
    address: "Section 19/1, Petaling Jaya, Selangor",
  }],
  hours: { general: "Tue-Fri 10am-8pm; Sat-Sun 10am-6pm", closed: "Monday closed" },
};
const awaitingStaff = {
  shouldRespond: true,
  flagged: true,
  privateReply: "我帮您向团队确认一下具体的分店位置后再回复您可以吗？",
  publicReply: "Please DM us",
};

test("clear Chinese Penang comment gets the verified PJ branch and no staff review", () => {
  const result = correctVerifiedCommentBusinessReply({
    customerText: "有在槟城有店铺吗?",
    copy: awaitingStaff,
    config,
  });
  assert.equal(result.flagged, false);
  assert.match(result.privateReply, /Petaling Jaya/);
  assert.match(result.privateReply, /Section 19\/1/);
  assert.doesNotMatch(result.privateReply, /团队|确认一下/);
});

test("English and Malay simple branch queries use the same configured address", () => {
  for (const text of ["Is there a branch in Penang?", "Ada cawangan di Penang?"]) {
    const result = correctVerifiedCommentBusinessReply({
      customerText: text,
      copy: { ...awaitingStaff, privateReply: "I'll check with the team and get back to you." },
      config,
    });
    assert.equal(result.flagged, false, text);
    assert.match(result.privateReply, /Petaling Jaya/, text);
    assert.match(result.privateReply, /Section 19\/1/, text);
  }
});

test("known opening hours can resolve an unnecessary administrative handoff", () => {
  const result = correctVerifiedCommentBusinessReply({
    customerText: "What are your opening hours?",
    copy: { ...awaitingStaff, privateReply: "I'll confirm with the team." },
    config,
  });
  assert.equal(result.flagged, false);
  assert.match(result.privateReply, /Tue-Fri 10am-8pm/);
});

test("natural verified AI replies remain untouched", () => {
  const normal = { ...awaitingStaff, flagged: false, privateReply: "We're in PJ 😊" };
  assert.equal(correctVerifiedCommentBusinessReply({
    customerText: "Where is your clinic?", copy: normal, config,
  }), normal);
});

test("medical, complaint, human requests and mixed price questions keep review", () => {
  for (const text of [
    "Is the clinic safe after surgery?",
    "My breasts hurt, where is your clinic?",
    "Where is your clinic? I want a refund",
    "Can I speak to staff at the clinic?",
    "Where is your clinic and how much is pelvic treatment?",
    "Is there a branch in Penang? I have breast cancer",
  ]) {
    const result = correctVerifiedCommentBusinessReply({
      customerText: text, copy: awaitingStaff, config,
    });
    assert.equal(result, awaitingStaff, text);
  }
});

test("unknown or ambiguous branch facts never suppress staff review", () => {
  for (const branches of [
    [],
    [{ name: "PJ", address: "" }],
    [config.branches[0], { name: "Penang", address: "Penang" }],
  ]) {
    const result = correctVerifiedCommentBusinessReply({
      customerText: "有在槟城有店铺吗?",
      copy: awaitingStaff,
      config: { ...config, branches },
    });
    assert.equal(result, awaitingStaff);
  }
});

test("deterministic safety handoff and skipped comments are preserved", () => {
  for (const copy of [
    { ...awaitingStaff, deterministicSafety: true },
    { ...awaitingStaff, shouldRespond: false },
  ]) {
    assert.equal(correctVerifiedCommentBusinessReply({
      customerText: "Where is your clinic?", copy, config,
    }), copy);
  }
});

test("location recognition stays narrow", () => {
  assert.equal(verifiedAnswerKind("有在槟城有店铺吗?"), "location");
  assert.equal(verifiedAnswerKind("Where is your clinic?"), "location");
  assert.equal(verifiedAnswerKind("Ada cawangan di Penang?"), "location");
  assert.equal(verifiedAnswerKind("营业时间是几点？"), "hours");
  assert.equal(verifiedAnswerKind("Pelvic treatment price?"), null);
});
