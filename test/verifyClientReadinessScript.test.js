const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parseArgs,
  readJsonFile,
  resolveContract,
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
