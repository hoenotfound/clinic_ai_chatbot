const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parseArgs,
  readJsonFile,
  resolveContract,
  updateReceiptReadiness,
} = require("../scripts/verifyClientReadiness");

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "verify-client-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("verify-client parser keeps passwords out of CLI-supported flags", () => {
  const args = parseArgs([
    "--url", "https://client.example",
    "--industry", "home_renovation",
    "--channels", "whatsapp,instagram",
    "--runtime-env-file", "client.env",
  ]);
  assert.equal(args.url, "https://client.example");
  assert.equal(args.channels, "whatsapp,instagram");
  assert.throws(() => parseArgs(["--password", "secret"]), /Unknown argument/);
});

test("receipt can supply URL, industry and required channels for repeat verification", (t) => {
  const directory = tempDir(t);
  const receiptPath = path.join(directory, "acme.json");
  fs.writeFileSync(receiptPath, JSON.stringify({
    industry: "home_renovation",
    requiredChannels: ["whatsapp", "instagram"],
    render: { url: "https://acme.onrender.com" },
  }));

  const receipt = readJsonFile(receiptPath);
  assert.equal(receipt.industry, "home_renovation");
  const contract = resolveContract({ receiptPath });
  assert.equal(contract.url, "https://acme.onrender.com");
  assert.equal(contract.industry, "home_renovation");
  assert.deepEqual(contract.channels, ["whatsapp", "instagram"]);
  assert.equal(contract.receipt.industry, "home_renovation");
});

test("explicit verification arguments override receipt contract fields", (t) => {
  const directory = tempDir(t);
  const receiptPath = path.join(directory, "acme.json");
  fs.writeFileSync(receiptPath, JSON.stringify({
    industry: "aesthetic_clinic",
    requiredChannels: ["whatsapp"],
    render: { url: "https://old.onrender.com" },
  }));

  const contract = resolveContract({
    receiptPath,
    url: "https://new.onrender.com",
    industry: "generic",
    channels: "instagram",
  });
  assert.equal(contract.url, "https://new.onrender.com");
  assert.equal(contract.industry, "generic");
  assert.deepEqual(contract.channels, ["instagram"]);
});

test("standalone verification atomically replaces stale readiness in the receipt", (t) => {
  const directory = tempDir(t);
  const receiptPath = path.join(directory, "acme.json");
  const original = {
    version: 2,
    industry: "home_renovation",
    requiredChannels: ["whatsapp"],
    render: { url: "https://acme.onrender.com" },
    readiness: { status: "needs_attention", ready: false },
  };
  fs.writeFileSync(receiptPath, JSON.stringify(original));

  const report = {
    status: "ready",
    ready: true,
    verificationCompleted: true,
    checkedAt: "2026-09-08T14:00:00.000Z",
    requiredChannels: ["whatsapp"],
    blocking: [],
    warnings: [],
  };

  updateReceiptReadiness(receiptPath, original, report);
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(saved.version, 3);
  assert.equal(saved.lastVerifiedAt, "2026-09-08T14:00:00.000Z");
  assert.equal(saved.readiness.status, "ready");
  assert.equal(saved.readiness.ready, true);
});

test("successful verification clears completed staged onboarding state", (t) => {
  const directory = tempDir(t);
  const receiptPath = path.join(directory, "staged.json");
  const original = {
    version: 4,
    industry: "tcm_clinic",
    requiredChannels: ["whatsapp", "facebook", "instagram"],
    render: { url: "https://staged.onrender.com" },
    channelReadinessDeferred: true,
    stagedReadiness: {
      acceptable: true,
      pendingChannelCount: 8,
      pendingChannelKeys: ["whatsapp", "facebook", "instagram", "meta_webhook"],
    },
    readiness: { status: "needs_attention", ready: false },
  };
  fs.writeFileSync(receiptPath, JSON.stringify(original));

  const report = {
    status: "ready_with_warnings",
    ready: true,
    verificationCompleted: true,
    checkedAt: "2026-09-24T06:00:00.000Z",
    requiredChannels: ["whatsapp", "facebook", "instagram"],
    blocking: [],
    warnings: [{ key: "system_health_ai", status: "warning" }],
  };

  updateReceiptReadiness(receiptPath, original, report);
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(saved.channelReadinessDeferred, false);
  assert.equal(saved.stagedReadiness, null);
  assert.equal(saved.readiness.status, "ready_with_warnings");
});

test("failed repeat verification keeps staged onboarding state", (t) => {
  const directory = tempDir(t);
  const receiptPath = path.join(directory, "staged-pending.json");
  const original = {
    version: 4,
    industry: "tcm_clinic",
    requiredChannels: ["whatsapp"],
    render: { url: "https://staged.onrender.com" },
    channelReadinessDeferred: true,
    stagedReadiness: {
      acceptable: true,
      pendingChannelCount: 2,
      pendingChannelKeys: ["whatsapp", "whatsapp_webhook"],
    },
  };
  fs.writeFileSync(receiptPath, JSON.stringify(original));

  const report = {
    status: "needs_attention",
    ready: false,
    verificationCompleted: true,
    checkedAt: "2026-09-24T06:05:00.000Z",
    requiredChannels: ["whatsapp"],
    blocking: [{ key: "whatsapp", status: "not_configured" }],
    warnings: [],
  };

  updateReceiptReadiness(receiptPath, original, report);
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(saved.channelReadinessDeferred, true);
  assert.equal(saved.stagedReadiness.pendingChannelCount, 2);
});
