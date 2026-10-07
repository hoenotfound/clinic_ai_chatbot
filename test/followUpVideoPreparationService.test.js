const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
  MAX_WHATSAPP_VIDEO_BYTES,
  parseFfmpegDuration,
  bitratePlan,
  prepareFollowUpVideoFile,
} = require("../src/services/followUpVideoPreparationService");

async function withTempInput(buffer, work) {
  const inputPath = path.join(
    os.tmpdir(),
    `follow-up-video-test-${process.pid}-${crypto.randomUUID()}.mp4`
  );
  await fs.writeFile(inputPath, buffer);
  try {
    return await work(inputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }
}

test("parses FFmpeg duration output", () => {
  assert.equal(
    parseFfmpegDuration("Duration: 00:01:23.45, start: 0.000000, bitrate: 1200 kb/s"),
    83.45
  );
  assert.equal(parseFfmpegDuration("no duration here"), null);
});

test("compression bitrate plan keeps a practical H.264/AAC budget", () => {
  const plan = bitratePlan(60);
  assert.ok(plan.videoKbps >= 96);
  assert.ok(plan.videoKbps <= 3000);
  assert.ok([48, 64, 96].includes(plan.audioKbps));
  assert.ok([540, 720, 960, 1280].includes(plan.maxDimension));
});

test("compression planner rejects videos too long for a usable <=16MB copy", () => {
  assert.throws(
    () => bitratePlan(60 * 60),
    (error) => error?.code === "FOLLOW_UP_VIDEO_TOO_LONG"
  );
});

test("follow-up video preparation bypasses FFmpeg for an already-safe MP4", async () => {
  const source = Buffer.from("already-small");
  await withTempInput(source, async (inputPath) => {
    let probed = false;
    let transcoded = false;
    const prepared = await prepareFollowUpVideoFile(inputPath, {
      originalBytes: source.length,
      probeDurationFn: async () => {
        probed = true;
        return 30;
      },
      transcodeFn: async () => {
        transcoded = true;
      },
    });

    assert.equal(prepared.compressed, false);
    assert.equal(prepared.originalBytes, source.length);
    assert.equal(prepared.storedBytes, source.length);
    assert.deepEqual(prepared.buffer, source);
    assert.equal(probed, false);
    assert.equal(transcoded, false);
  });
});

test("follow-up video preparation compresses a >16MB source before storage", async () => {
  await withTempInput(Buffer.from("source-placeholder"), async (inputPath) => {
    let planSeen = null;
    const prepared = await prepareFollowUpVideoFile(inputPath, {
      originalBytes: 20 * 1024 * 1024,
      probeDurationFn: async () => 45,
      transcodeFn: async (sourcePath, outputPath, plan) => {
        assert.equal(sourcePath, inputPath);
        planSeen = plan;
        await fs.writeFile(outputPath, Buffer.from("whatsapp-safe"));
      },
    });

    assert.equal(prepared.compressed, true);
    assert.equal(prepared.originalBytes, 20 * 1024 * 1024);
    assert.equal(prepared.storedBytes, Buffer.byteLength("whatsapp-safe"));
    assert.deepEqual(prepared.buffer, Buffer.from("whatsapp-safe"));
    assert.ok(planSeen.videoKbps > 0);
  });
});

test("follow-up video preparation refuses output that still exceeds the provider cap", async () => {
  await withTempInput(Buffer.from("source-placeholder"), async (inputPath) => {
    await assert.rejects(
      prepareFollowUpVideoFile(inputPath, {
        originalBytes: 20,
        maxUploadBytes: 100,
        maxWhatsAppBytes: 5,
        probeDurationFn: async () => 45,
        transcodeFn: async (sourcePath, outputPath) => {
          await fs.writeFile(outputPath, Buffer.alloc(6));
        },
      }),
      (error) => error?.code === "FOLLOW_UP_VIDEO_STILL_TOO_LARGE"
    );
  });
});

test("follow-up video preparation enforces the 50MB source cap", async () => {
  await withTempInput(Buffer.from("source-placeholder"), async (inputPath) => {
    await assert.rejects(
      prepareFollowUpVideoFile(inputPath, {
        originalBytes: MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES + 1,
      }),
      (error) => error?.code === "FOLLOW_UP_VIDEO_UPLOAD_TOO_LARGE"
    );
  });
});

test("configured provider cap stays at 16MB", () => {
  assert.equal(MAX_WHATSAPP_VIDEO_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES, 50 * 1024 * 1024);
});
