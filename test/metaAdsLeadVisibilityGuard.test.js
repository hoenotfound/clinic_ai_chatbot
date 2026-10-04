const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipelineSource = fs.readFileSync(
  path.join(__dirname, "../src/routes/pipeline.js"),
  "utf8"
);
const analyticsSource = fs.readFileSync(
  path.join(__dirname, "../src/db/metaAdsAnalyticsRepo.js"),
  "utf8"
);
const inboxSource = fs.readFileSync(
  path.join(__dirname, "../portal-frontend/src/pages/Inbox.jsx"),
  "utf8"
);

test("Meta Ads lead details stay lazy and respect lead access", () => {
  const leadRouteAt = pipelineSource.indexOf(
    'router.get("/analytics/meta-ads/leads"'
  );
  const aggregateRouteAt = pipelineSource.indexOf(
    'router.get("/analytics/meta-ads"'
  );
  assert.ok(leadRouteAt >= 0, "lazy Meta Ads leads route should exist");
  assert.ok(
    aggregateRouteAt > leadRouteAt,
    "specific lazy lead route should be declared before aggregate Meta Ads analytics"
  );

  const leadRoute = pipelineSource.slice(leadRouteAt, aggregateRouteAt);
  assert.match(leadRoute, /getAccessibleLeadIds\(req\.user\)/);
  assert.match(leadRoute, /getMetaAdsLeadPreview/);
  assert.match(leadRoute, /accessibleLeadIds/);

  const aggregateStart = analyticsSource.indexOf(
    "async function getMetaAdsAnalytics("
  );
  const aggregateEnd = analyticsSource.indexOf(
    "module.exports",
    aggregateStart
  );
  const aggregateBody = analyticsSource.slice(aggregateStart, aggregateEnd);
  assert.doesNotMatch(
    aggregateBody,
    /await getMetaAdsLeadPreview/,
    "aggregate analytics must not eagerly run the customer-detail query"
  );
});

test("Inbox acquisition context renders outside the actions menu", () => {
  const menuAt = inboxSource.indexOf("{actionsOpen && (");
  const contextAt = inboxSource.indexOf("<AcquisitionContextBar", menuAt);
  const attentionBannerAt = inboxSource.indexOf(
    '{contact.needs_attention && (\n          <div className="flex items-center gap-2 border-t',
    menuAt
  );

  assert.ok(menuAt >= 0, "conversation actions menu should exist");
  assert.ok(contextAt > menuAt, "acquisition context should render after the header controls");
  assert.ok(attentionBannerAt > contextAt, "acquisition context should sit above the attention banner");

  const menuCloseAt = inboxSource.lastIndexOf("            )}", contextAt);
  assert.ok(
    menuCloseAt > menuAt && menuCloseAt < contextAt,
    "conversation actions menu should close before acquisition context renders"
  );
});
