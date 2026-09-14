const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseArgs,
  usage,
} = require("../scripts/recoverClientProvisioning");

test("recover-client CLI parses deterministic recovery controls", () => {
  const args = parseArgs([
    "--client", "acme",
    "--industry", "generic",
    "--channels", "whatsapp,instagram",
    "--runtime-env-file", "./acme.env",
    "--r2-location", "apac",
    "--render-plan", "starter",
    "--execute",
    "--json",
  ]);
  assert.equal(args.clientSlug, "acme");
  assert.equal(args.industry, "generic");
  assert.equal(args.channels, "whatsapp,instagram");
  assert.equal(args.runtimeEnvFile, "./acme.env");
  assert.equal(args.r2Location, "apac");
  assert.equal(args.renderPlan, "starter");
  assert.equal(args.execute, true);
  assert.equal(args.json, true);
  assert.match(usage(), /non-destructive/i);
});

test("recover-client CLI rejects unknown options and missing values", () => {
  assert.throws(() => parseArgs(["--unknown", "x"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--client"]), /requires a value/);
});
