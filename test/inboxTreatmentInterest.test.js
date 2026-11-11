"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { treatmentKey, createInboxTreatmentResolver } =
  require("../src/utils/inboxTreatmentInterest");

test("Inbox treatment resolver merges spacing variants and exact configured aliases", () => {
  const resolve = createInboxTreatmentResolver({
    services: [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }],
    serviceAliases: [
      { alias: "3D小颜", officialService: "3D 小颜术" },
      { alias: "Facial contouring", officialService: "3D 小颜术" },
      { alias: "9D lifting", officialService: "9D 逆龄抗衰" },
    ],
  });

  for (const name of ["3D 小颜术", "3D小颜术", "３Ｄ小颜术",
    "3D小颜", "Facial contouring"]) {
    assert.deepEqual(resolve(name), { key: "3d小颜术", label: "3D 小颜术" });
  }
  assert.deepEqual(resolve("9D lifting"), {
    key: "9d逆龄抗衰", label: "9D 逆龄抗衰",
  });
  assert.deepEqual(resolve("Unknown therapy"), {
    key: "unknowntherapy", label: "Unknown therapy",
  });
  assert.deepEqual(resolve(""), { key: "", label: "" });
  assert.equal(treatmentKey("3D  小颜术"), "3d小颜术");
});

test("ambiguous configured aliases are not silently assigned to one treatment", () => {
  const resolve = createInboxTreatmentResolver({
    services: [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }],
    serviceAliases: [
      { alias: "Face", officialService: "3D 小颜术" },
      { alias: "Face", officialService: "9D 逆龄抗衰" },
    ],
  });
  assert.deepEqual(resolve("Face"), { key: "face", label: "Face" });
  assert.deepEqual(resolve("9D 逆龄抗衰"), {
    key: "9d逆龄抗衰", label: "9D 逆龄抗衰",
  });
});
