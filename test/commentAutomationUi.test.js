const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("comment automation presents a simple ordinary-user setup flow", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "pages", "Tools.jsx"),
    "utf8"
  );

  assert.match(source, /title="Where should this work\?"/);
  assert.match(source, /title="What should happen when someone comments\?"/);
  assert.match(source, /Reply publicly \+ send a private message/);
  assert.match(source, /Send a private message only/);
  assert.match(source, /Reply publicly only/);
  assert.match(source, /Advanced settings/);
  assert.match(source, /Customer experience preview/);
  assert.match(source, /Before you turn it on/);
  assert.match(source, /Run one real comment test/);
  assert.match(source, /Save & turn on/);
  assert.match(source, /Save & pause/);
});

test("comment automation separates connection readiness from channel selection", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "pages", "Tools.jsx"),
    "utf8"
  );

  assert.match(source, /function CommentChannelCard\(/);
  assert.match(source, /Connection<\/span>/);
  assert.match(source, /Automation \{checked \? "selected" : "not selected"\}/);
  assert.match(source, /Check connection/);
  assert.match(source, /Connections look ready/);
  assert.match(source, /One or more selected channels still need setup/);
});

test("comment automation keeps advanced controls collapsed and delays split layout until wide desktop", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "pages", "Tools.jsx"),
    "utf8"
  );

  assert.match(source, /<details className="group/);
  assert.match(source, /min-\[1800px\]:grid-cols/);
  assert.match(source, /min-\[1800px\]:sticky/);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /text-base leading-6[\s\S]*sm:text-sm/);
});
