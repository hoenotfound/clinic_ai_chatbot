const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const {
  MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
  MAX_WHATSAPP_VIDEO_BYTES,
  parseFfmpegDuration,
  parseFfmpegMediaInfo,
  isWhatsAppSafeVideoInfo,
  probeVideoInfo,
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

test("parses FFmpeg duration and codec metadata", () => {
  assert.equal(
    parseFfmpegDuration("Duration: 00:01:23.45, start: 0.000000, bitrate: 1200 kb/s"),
    83.45
  );
  assert.equal(parseFfmpegDuration("no duration here"), null);

  assert.deepEqual(
    parseFfmpegMediaInfo(
      "Duration: 00:00:12.50, start: 0.000000, bitrate: 1200 kb/s\n" +
      "Stream #0:0: Video: hevc (Main), yuv420p\n" +
      "Stream #0:1: Audio: aac (LC), 44100 Hz"
    ),
    {
      durationSeconds: 12.5,
      videoCodec: "hevc",
      audioCodec: "aac",
    }
  );
});

test("WhatsApp compatibility accepts H.264/AAC and rejects HEVC", () => {
  assert.equal(
    isWhatsAppSafeVideoInfo({
      durationSeconds: 10,
      videoCodec: "h264",
      audioCodec: "aac",
    }),
    true
  );
  assert.equal(
    isWhatsAppSafeVideoInfo({
      durationSeconds: 10,
      videoCodec: "h264",
      audioCodec: null,
    }),
    true
  );
  assert.equal(
    isWhatsAppSafeVideoInfo({
      durationSeconds: 10,
      videoCodec: "hevc",
      audioCodec: "aac",
    }),
    false
  );
});

test("video probe opens the file in inspection-only mode with bounded threads", async () => {
  const argsSeen = [];
  const fakeSpawn = (binary, args) => {
    argsSeen.push({ binary, args });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stderr.emit(
        "data",
        Buffer.from(
          "Duration: 00:00:03.00, start: 0.000000, bitrate: 800 kb/s\n" +
          "Stream #0:0: Video: h264 (Main), yuv420p\n" +
          "Stream #0:1: Audio: aac (LC), 44100 Hz"
        )
      );
      child.emit("close", 1);
    });
    return child;
  };

  const info = await probeVideoInfo("/tmp/input.mp4", { spawnFn: fakeSpawn });

  assert.equal(info.videoCodec, "h264");
  assert.equal(info.audioCodec, "aac");
  assert.equal(argsSeen.length, 1);
  assert.deepEqual(argsSeen[0].args.slice(0, 5), [
    "-hide_banner",
    "-nostdin",
    "-threads",
    "1",
    "-i",
  ]);
  assert.equal(
    argsSeen[0].args.some((arg) => String(arg).includes("libx264")),
    false,
    "compatibility probing must never start a video encoder"
  );
});

test("safe H.264/AAC video is returned unchanged with no compression", async () => {
  const source = Buffer.from("safe-h264-video");
  await withTempInput(source, async (inputPath) => {
    const prepared = await prepareFollowUpVideoFile(inputPath, {
      originalBytes: source.length,
      ensureWhatsAppCompatible: true,
      probeVideoInfoFn: async () => ({
        durationSeconds: 20,
        videoCodec: "h264",
        audioCodec: "aac",
      }),
    });

    assert.deepEqual(prepared.buffer, source);
    assert.equal(prepared.compressed, false);
    assert.equal(prepared.transcoded, false);
    assert.equal(prepared.sourceVideoCodec, "h264");
    assert.equal(prepared.sourceAudioCodec, "aac");
    assert.equal(prepared.originalBytes, source.length);
    assert.equal(prepared.storedBytes, source.length);
  });
});

test("HEVC video is rejected instead of transcoded", async () => {
  await withTempInput(Buffer.from("hevc-video"), async (inputPath) => {
    await assert.rejects(
      prepareFollowUpVideoFile(inputPath, {
        originalBytes: 1024,
        ensureWhatsAppCompatible: true,
        probeVideoInfoFn: async () => ({
          durationSeconds: 20,
          videoCodec: "hevc",
          audioCodec: "aac",
        }),
      }),
      (error) => {
        assert.equal(error?.code, "WHATSAPP_VIDEO_CODEC_UNSUPPORTED");
        assert.match(error.message, /H\.264 video with AAC audio/);
        assert.match(error.message, /Automatic conversion is disabled/);
        return true;
      }
    );
  });
});

test("videos larger than 16MB are rejected instead of compressed", async () => {
  await withTempInput(Buffer.from("placeholder"), async (inputPath) => {
    await assert.rejects(
      prepareFollowUpVideoFile(inputPath, {
        originalBytes: MAX_WHATSAPP_VIDEO_BYTES + 1,
      }),
      (error) => {
        assert.equal(error?.code, "WHATSAPP_VIDEO_TOO_LARGE");
        assert.match(error.message, /larger than 16MB/);
        assert.match(error.message, /Automatic video compression is disabled/);
        return true;
      }
    );
  });
});

test("video probe timeout kills only the inspection child", async () => {
  let killed = false;
  const keepAlive = setTimeout(() => {}, 100);
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      killed = true;
      setTimeout(() => child.emit("close", null, "SIGKILL"), 5);
      return true;
    };
    return child;
  };

  try {
    await assert.rejects(
      probeVideoInfo("/tmp/input.mp4", {
        spawnFn: fakeSpawn,
        timeoutMs: 1,
      }),
      (error) => error?.code === "INVALID_FOLLOW_UP_VIDEO"
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(killed, true);
});

test("video upload cap equals WhatsApp's 16MB provider limit", () => {
  assert.equal(MAX_WHATSAPP_VIDEO_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES, MAX_WHATSAPP_VIDEO_BYTES);
});
