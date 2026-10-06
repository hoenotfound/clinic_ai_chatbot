const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../src/createApp.js"), "utf8");

test("server entry point delegates Express composition without moving message processing", () => {
  assert.match(serverSource, /async function processIncomingMessage\(/);
  assert.match(serverSource, /async function processIncomingBatch\(/);
  assert.match(serverSource, /const app = createApp\(\{/);
  assert.match(serverSource, /startApplication\(\{/);

  assert.doesNotMatch(serverSource, /const app = express\(\)/);
  assert.doesNotMatch(serverSource, /app\.use\(/);
  assert.doesNotMatch(serverSource, /app\.get\(/);
  assert.doesNotMatch(serverSource, /app\.post\(/);
});

test("application composition preserves security and readiness middleware ordering", () => {
  const portalParserAt = appSource.indexOf("const portalJsonParser = createPortalJsonParser()");
  const advancedParserAt = appSource.indexOf("const advancedConfigJsonParser = createAdvancedConfigJsonParser()");
  const parserMuxAt = appSource.indexOf('app.use("/api", (req, res, next) => {');
  const securityHeadersAt = appSource.indexOf("app.use(applyPortalSecurityHeaders)");
  const originGuardAt = appSource.indexOf('app.use("/api", enforcePortalRequestOrigin)');
  const sessionAt = appSource.indexOf("cookieSession(buildPortalSessionOptions(");
  const rootHealthAt = appSource.indexOf('app.get("/", startupReadiness.rootReadinessHandler)');
  const readinessGateAt = appSource.indexOf("app.use(startupReadiness.requireReady)");
  const whatsappAt = appSource.indexOf('app.get("/webhook"');
  const opsAt = appSource.indexOf('app.use("/api/ops/readiness", opsReadinessRoutes)');
  const authAt = appSource.indexOf('app.use("/api/auth", authRoutes)');
  const protectedConversationsAt = appSource.indexOf(
    'app.use("/api/conversations", requireAuth, conversationsRoutes)'
  );
  const payloadHandlerAt = appSource.indexOf("app.use(payloadTooLargeErrorHandler)");
  const staticAt = appSource.indexOf("app.use(express.static(portalBuildPath))");

  assert.ok(portalParserAt >= 0, "normal portal JSON parser should remain installed");
  assert.ok(advancedParserAt > portalParserAt, "Advanced Config should get its own parser");
  assert.ok(parserMuxAt > advancedParserAt, "API parser selection should be installed");
  assert.ok(
    appSource.includes('req.path === "/advanced-config" || req.path.startsWith("/advanced-config/")'),
    "only Advanced Config should select the larger JSON parser"
  );
  assert.ok(securityHeadersAt >= 0, "portal security headers should be installed");
  assert.ok(originGuardAt > securityHeadersAt, "API origin guard should run after global security headers");
  assert.ok(originGuardAt < parserMuxAt, "API origin guard should run before body parsing");
  assert.ok(sessionAt > parserMuxAt, "session middleware should stay after portal parsing");
  assert.ok(rootHealthAt > sessionAt, "health routes should remain after API session setup");
  assert.ok(readinessGateAt > rootHealthAt, "readiness must gate non-health traffic");
  assert.ok(whatsappAt > readinessGateAt, "webhook traffic must stay readiness-gated");
  assert.ok(opsAt > whatsappAt, "Ops endpoint should remain after webhook routes");
  assert.ok(authAt > opsAt, "Ops readiness must remain outside portal auth");
  assert.ok(protectedConversationsAt > authAt, "portal data routes must remain authenticated");
  assert.ok(payloadHandlerAt > protectedConversationsAt, "413 handler stays after parsed routes");
  assert.ok(staticAt > payloadHandlerAt, "portal static fallback stays last");
});

test("webhook parsers still verify raw signatures and portal routes stay protected", () => {
  assert.match(
    appSource,
    /createWebhookJsonParser\(verifyWebhookSignature\)/
  );
  assert.match(
    appSource,
    /createWebhookJsonParser\(verifyMetaWebhookSignature\)/
  );
  assert.match(appSource, /app\.post\("\/webhook", webhookJsonParser/);
  assert.match(appSource, /app\.post\("\/meta-webhook", metaWebhookJsonParser/);

  assert.match(
    appSource,
    /app\.set\("trust proxy", resolveTrustProxy\(process\.env\)\)/
  );
  assert.match(
    appSource,
    /verifyTokenMatches\(token, process\.env\.WHATSAPP_VERIFY_TOKEN\)/
  );
  assert.match(
    appSource,
    /verifyTokenMatches\(token, process\.env\.META_VERIFY_TOKEN\)/
  );
  assert.doesNotMatch(
    appSource,
    /token === process\.env\.(WHATSAPP_VERIFY_TOKEN|META_VERIFY_TOKEN)/
  );

  for (const route of [
    "conversations",
    "config",
    "advanced-config",
    "contacts",
    "pipeline",
    "setup-status",
    "go-live",
  ]) {
    const pattern = new RegExp(
      `app\\.use\\("\\/api\\/${route.replace("-", "\\-")}", requireAuth,`
    );
    assert.match(appSource, pattern);
  }
});


test("urgent safety handling bypasses model generation and first-message intro copy", () => {
  const urgentBranchAt = serverSource.indexOf("if (urgentSafety) {");
  const aiCallAt = serverSource.indexOf("const rawAiReply = await ai.getReply");
  const replyAt = serverSource.indexOf("const reply = isFirstMessage && !urgentSafety");

  assert.ok(urgentBranchAt >= 0, "urgent deterministic branch should exist");
  assert.ok(aiCallAt > urgentBranchAt, "AI generation must be nested after the urgent branch");
  assert.ok(replyAt > aiCallAt, "reply composition should follow deterministic/model selection");
  assert.match(
    serverSource,
    /fallbackHandoffReply\([\s\S]*?\{ urgent: true \}/
  );
});


test("optional result media exceptions stay isolated from the main AI handoff path", () => {
  const resultStart = serverSource.indexOf("// Result examples are optional social proof");
  const localCatch = serverSource.indexOf("} catch (resultMediaErr)", resultStart);
  const globalCatch = serverSource.indexOf("} catch (err)", localCatch);

  assert.ok(resultStart >= 0, "optional result media block should exist");
  assert.ok(localCatch > resultStart, "result media should have its own exception boundary");
  assert.ok(globalCatch > localCatch, "local result-media catch must run before the main inbound catch");

  const isolatedBlock = serverSource.slice(resultStart, globalCatch);
  assert.match(isolatedBlock, /getMostRecentlySentMediaUrl/);
  assert.match(isolatedBlock, /setDeliveryStatusById\([\s\S]*?"unknown"/);
  assert.doesNotMatch(isolatedBlock, /pauseAiForHumanHandoff/);
});


test("post-reply runtime keeps text then promo then result-media ordering and forwards service intent", () => {
  const textSendAt = serverSource.indexOf("const sendOutcome = await sendTrackedText(");
  const promoResolveAt = serverSource.indexOf("resolvePricePromotionForReply({", textSendAt);
  const resultResolveAt = serverSource.indexOf("resolveResultMediaForReply({", promoResolveAt);

  assert.ok(textSendAt >= 0, "normal AI text send should exist");
  assert.ok(promoResolveAt > textSendAt, "promotion resolution must happen after text");
  assert.ok(resultResolveAt > promoResolveAt, "result media must resolve only after promotion flow");
  assert.match(
    serverSource.slice(promoResolveAt, resultResolveAt),
    /automaticPromoMediaSent \+= 1/
  );
  assert.match(
    serverSource.slice(resultResolveAt - 500, resultResolveAt),
    /automaticPromoMediaSent <= 1/
  );

  const promoCall = serverSource.slice(promoResolveAt, resultResolveAt);
  const resultCall = serverSource.slice(resultResolveAt, resultResolveAt + 1200);
  assert.match(serverSource, /const customerMediaLanguage = detectConversationLanguage\(/);
  assert.match(serverSource, /\.reverse\(\)[\s\S]*?message\?\.role === "user"/);
  assert.match(
    serverSource,
    /const mediaLanguage = detectConversationLanguage\([\s\S]*?\[aiReply\],[\s\S]*?customerMediaLanguage/
  );
  assert.match(promoCall, /language: mediaLanguage/);
  assert.match(resultCall, /serviceQuery,/);
  assert.match(resultCall, /serviceQuerySource,/);
  assert.match(resultCall, /metaAdCreativeService,/);
  assert.match(resultCall, /priceQuery,/);
  assert.match(resultCall, /packageQuery,/);
  assert.match(resultCall, /language: mediaLanguage/);
});
