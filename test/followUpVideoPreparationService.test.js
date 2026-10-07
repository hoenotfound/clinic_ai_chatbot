const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const ffmpegPath = require("ffmpeg-static");

const {
  MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
  MAX_WHATSAPP_VIDEO_BYTES,
  parseFfmpegDuration,
  bitratePlan,
  runFfmpeg,
  prepareFollowUpVideoFile,
} = require("../src/services/followUpVideoPreparationService");

function runBinary(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `process exited with code ${code}`));
    });
  });
}

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

test("real FFmpeg path produces a WhatsApp-safe H.264/AAC MP4", async () => {
  assert.ok(ffmpegPath, "ffmpeg-static binary should be available");
  const inputPath = path.join(
    os.tmpdir(),
    `follow-up-video-real-${process.pid}-${crypto.randomUUID()}.mp4`
  );
  try {
    await runBinary(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=size=320x240:rate=10",
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=44100",
      "-t", "1",
      "-c:v", "mpeg4",
      "-c:a", "aac",
      inputPath,
    ]);

    const prepared = await prepareFollowUpVideoFile(inputPath, {
      // Force the preparation branch without creating a real 16MB fixture.
      originalBytes: 20 * 1024 * 1024,
    });

    assert.equal(prepared.compressed, true);
    assert.ok(prepared.storedBytes > 0);
    assert.ok(prepared.storedBytes <= MAX_WHATSAPP_VIDEO_BYTES);
    const ascii = prepared.buffer.toString("latin1");
    assert.match(ascii, /ftyp/);
    assert.match(ascii, /avc1/);
    assert.match(ascii, /mp4a/);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }
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

test("FFmpeg timeout waits for the killed encoder to exit before rejecting", async () => {
  let killed = false;
  const keepAlive = setTimeout(() => {}, 250);
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      killed = true;
      setTimeout(() => child.emit("close", null, "SIGKILL"), 25);
      return true;
    };
    return child;
  };

  const startedAt = Date.now();
  try {
    await assert.rejects(
      runFfmpeg(["-version"], {
        spawnFn: fakeSpawn,
        timeoutMs: 5,
      }),
      (error) => error?.code === "FOLLOW_UP_VIDEO_COMPRESSION_TIMEOUT"
    );
  } finally {
    clearTimeout(keepAlive);
  }

  assert.equal(killed, true);
  assert.ok(
    Date.now() - startedAt >= 20,
    "timeout must not release before the encoder close event"
  );
});

test("configured provider cap stays at 16MB", () => {
  assert.equal(MAX_WHATSAPP_VIDEO_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES, 50 * 1024 * 1024);
});
