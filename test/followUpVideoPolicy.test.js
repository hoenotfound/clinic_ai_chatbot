const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { previouslySentVideo } = require("../src/utils/followUpVideoPolicy");

test("previouslySentVideo prevents repeat media after confirmed, pending or manual sends", async () => {
  const captured = [];
  const database = {
    query: async (sql, params) => {
      captured.push({ sql, params });
      return { rows: [{ "?column?": 1 }] };
    },
  };
  assert.equal(await previouslySentVideo({
    database, contactId: 123, mediaKey: "clients/demo/video.mp4",
  }), true);
  assert.match(captured[0].sql, /role = 'assistant'/);
  assert.match(captured[0].sql, /media_key = \$2/);
  assert.match(captured[0].sql, /interval '7 days'/);
  assert.match(captured[0].sql, /delivery_status IS DISTINCT FROM 'failed'/);
  assert.match(captured[0].sql, /delivery_status IS DISTINCT FROM 'cancelled'/);
  assert.deepEqual(captured[0].params, [123, "clients/demo/video.mp4", null]);
});

test("previouslySentVideo supports excluding its own pending claim", async () => {
  const database = {
    query: async (_, params) => {
      assert.deepEqual(params, [123, "clients/demo/video.mp4", 789]);
      return { rows: [] };
    },
  };
  assert.equal(await previouslySentVideo({
    database, contactId: 123, mediaKey: "clients/demo/video.mp4", excludeMessageId: 789,
  }), false);
});

test("normal follow-up safely downgrades a duplicate or unverified video to text", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  assert.match(code, /duplicate media suppressed/);
  assert.match(code, /effectiveVideoKey = ""/);
  assert.match(code, /excludeMessageId: saved\.id/);
  assert.match(code, /if \(!eligible\) return false/);
});


test("suppressed videos are replaced by truthful treatment-matched text in every language", () => {
  const { textOnlyVideoFallback } = require("../src/utils/followUpVideoPolicy");
  for (const language of ["zh", "en", "ms"]) {
    for (const stepIndex of [1, 2]) {
      const pelvic = textOnlyVideoFallback({
        language, serviceName: "骨盆调理", stepIndex,
      });
      const facial = textOnlyVideoFallback({
        language, serviceName: "3D 小颜术", stepIndex,
      });
      assert.ok(pelvic.length > 30);
      assert.ok(facial.length > 30);
      assert.notEqual(pelvic, facial);
      assert.doesNotMatch(pelvic, /这段影片|请看视频|attached video|video attached|video ini/iu);
      assert.doesNotMatch(facial, /这段影片|请看视频|attached video|video attached|video ini/iu);
      assert.doesNotMatch(facial, /体态评估|body assessment/iu);
    }
  }
});

test("video-first follow-up supports Neutro AI captions, social safety checks and safe fallback", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  assert.match(code, /videoAiCaptionsEnabled/);
  assert.match(code, /textOnlyVideoFallback\(/);
  assert.match(code, /social.+caption/iu);
  assert.match(code, /duplicateBeforeSend/);
  assert.match(code, /excludeMessageId: videoMessage\.id/);
  assert.match(code, /mediaKey: sourceVideoKey/);
});
