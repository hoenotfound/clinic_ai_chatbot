const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ffmpegPath = require("ffmpeg-static");

const MIB = 1024 * 1024;
const MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES = 50 * MIB;
const MAX_WHATSAPP_VIDEO_BYTES = 16 * MIB;
const TARGET_WHATSAPP_VIDEO_BYTES = 15 * MIB;
const MIN_VIDEO_KBPS = 96;
const MIN_AUDIO_KBPS = 48;
const MAX_VIDEO_KBPS = 3000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

function followUpVideoError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseFfmpegDuration(stderr) {
  const match = String(stderr || "").match(
    /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/
  );
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function createCompressionQueue({
  maxWaiting = 2,
  waitTimeoutMs = 5 * 60 * 1000,
} = {}) {
  let active = false;
  const waiting = [];

  function lease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(lease());
      } else {
        active = false;
      }
    };
  }

  return {
    acquire() {
      if (!active) {
        active = true;
        return Promise.resolve(lease());
      }
      if (waiting.length >= maxWaiting) {
        return Promise.reject(
          followUpVideoError(
            "Video compression is busy. Please try again shortly.",
            "FOLLOW_UP_VIDEO_COMPRESSION_BUSY"
          )
        );
      }
      return new Promise((resolve, reject) => {
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(
            followUpVideoError(
              "Video compression is busy. Please try again shortly.",
              "FOLLOW_UP_VIDEO_COMPRESSION_BUSY"
            )
          );
        }, waitTimeoutMs);
        entry.timer.unref?.();
        waiting.push(entry);
      });
    },
  };
}

const compressionQueue = createCompressionQueue();

function bitratePlan(durationSeconds, {
  targetBytes = TARGET_WHATSAPP_VIDEO_BYTES,
} = {}) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw followUpVideoError(
      "This MP4 does not have a readable duration.",
      "INVALID_FOLLOW_UP_VIDEO"
    );
  }

  // Leave room for MP4 container overhead and encoder variance. Two-pass H.264
  // then spends the remaining budget much more predictably than CRF encoding.
  const totalKbps = Math.floor((targetBytes * 8) / duration / 1000);
  const audioKbps =
    totalKbps >= 500 ? 96 : totalKbps >= 250 ? 64 : MIN_AUDIO_KBPS;
  const containerAllowanceKbps = 16;
  const uncappedVideoKbps = totalKbps - audioKbps - containerAllowanceKbps;

  if (uncappedVideoKbps < MIN_VIDEO_KBPS) {
    throw followUpVideoError(
      "This video is too long to compress below WhatsApp's 16MB limit with usable audio and video quality.",
      "FOLLOW_UP_VIDEO_TOO_LONG"
    );
  }

  const videoKbps = Math.min(MAX_VIDEO_KBPS, uncappedVideoKbps);
  const maxDimension =
    videoKbps >= 1800 ? 1280
      : videoKbps >= 900 ? 960
        : videoKbps >= 450 ? 720
          : 540;

  return {
    audioKbps,
    videoKbps,
    maxDimension,
  };
}

function probeDurationSeconds(
  inputPath,
  {
    spawnFn = spawn,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {}
) {
  if (!ffmpegPath) {
    return Promise.reject(
      followUpVideoError(
        "Video compression is unavailable on this server.",
        "FOLLOW_UP_VIDEO_COMPRESSION_UNAVAILABLE"
      )
    );
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(
        ffmpegPath,
        ["-hide_banner", "-i", inputPath],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
    } catch (error) {
      reject(error);
      return;
    }

    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(
        followUpVideoError(
          "The video took too long to inspect.",
          "INVALID_FOLLOW_UP_VIDEO"
        )
      );
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 128 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const duration = parseFfmpegDuration(stderr);
      if (!duration) {
        reject(
          followUpVideoError(
            "This MP4 could not be read. Please export it again as a standard MP4 video.",
            "INVALID_FOLLOW_UP_VIDEO"
          )
        );
        return;
      }
      resolve(duration);
    });
  });
}

function runFfmpeg(args, {
  spawnFn = spawn,
  timeoutMs = DEFAULT_TRANSCODE_TIMEOUT_MS,
} = {}) {
  if (!ffmpegPath) {
    return Promise.reject(
      followUpVideoError(
        "Video compression is unavailable on this server.",
        "FOLLOW_UP_VIDEO_COMPRESSION_UNAVAILABLE"
      )
    );
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(
        followUpVideoError(
          "Video compression timed out. Please try a shorter video.",
          "FOLLOW_UP_VIDEO_COMPRESSION_TIMEOUT"
        )
      );
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 128 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const error = followUpVideoError(
        "The video could not be compressed into a WhatsApp-compatible MP4.",
        "FOLLOW_UP_VIDEO_COMPRESSION_FAILED"
      );
      error.ffmpegStderr = stderr.slice(-4000);
      reject(error);
    });
  });
}

function videoEncodeArgs(inputPath, plan, passPrefix) {
  const scale =
    `scale=w=min(${plan.maxDimension}\\,iw):h=min(${plan.maxDimension}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-vf", scale,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-b:v", `${plan.videoKbps}k`,
    "-passlogfile", passPrefix,
    "-threads", "1",
  ];
}

async function transcodeTwoPass(
  inputPath,
  outputPath,
  plan,
  {
    runFfmpegFn = runFfmpeg,
    passPrefix = path.join(
      os.tmpdir(),
      `follow-up-video-pass-${process.pid}-${crypto.randomUUID()}`
    ),
  } = {}
) {
  const baseArgs = videoEncodeArgs(inputPath, plan, passPrefix);
  try {
    await runFfmpegFn([
      ...baseArgs,
      "-pass", "1",
      "-an",
      "-f", "null",
      os.devNull,
    ]);

    await runFfmpegFn([
      ...baseArgs,
      "-pass", "2",
      "-map", "0:a:0?",
      "-c:a", "aac",
      "-b:a", `${plan.audioKbps}k`,
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      "-sn",
      "-f", "mp4",
      outputPath,
    ]);
  } finally {
    await Promise.all([
      fs.unlink(`${passPrefix}-0.log`).catch(() => {}),
      fs.unlink(`${passPrefix}-0.log.mbtree`).catch(() => {}),
      fs.unlink(`${passPrefix}.log`).catch(() => {}),
      fs.unlink(`${passPrefix}.log.mbtree`).catch(() => {}),
    ]);
  }
}

async function prepareFollowUpVideoFile(
  inputPath,
  {
    originalBytes = null,
    fsApi = fs,
    queue = compressionQueue,
    probeDurationFn = probeDurationSeconds,
    transcodeFn = transcodeTwoPass,
    maxUploadBytes = MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
    maxWhatsAppBytes = MAX_WHATSAPP_VIDEO_BYTES,
    targetBytes = TARGET_WHATSAPP_VIDEO_BYTES,
  } = {}
) {
  const inputStat =
    Number.isFinite(originalBytes) && originalBytes >= 0
      ? { size: Number(originalBytes) }
      : await fsApi.stat(inputPath);
  const sourceBytes = inputStat.size;

  if (sourceBytes <= 0) {
    throw followUpVideoError(
      "The selected video is empty.",
      "INVALID_FOLLOW_UP_VIDEO"
    );
  }
  if (sourceBytes > maxUploadBytes) {
    throw followUpVideoError(
      "Video is too large. Please choose an MP4 file under 50MB.",
      "FOLLOW_UP_VIDEO_UPLOAD_TOO_LARGE"
    );
  }

  if (sourceBytes <= maxWhatsAppBytes) {
    return {
      buffer: await fsApi.readFile(inputPath),
      compressed: false,
      originalBytes: sourceBytes,
      storedBytes: sourceBytes,
    };
  }

  const release = await queue.acquire();
  const outputPath = path.join(
    os.tmpdir(),
    `follow-up-video-${process.pid}-${crypto.randomUUID()}.mp4`
  );

  try {
    const durationSeconds = await probeDurationFn(inputPath);
    let plan = bitratePlan(durationSeconds, { targetBytes });
    await transcodeFn(inputPath, outputPath, plan);

    let outputStat = await fsApi.stat(outputPath);
    if (outputStat.size > maxWhatsAppBytes) {
      // Two-pass encoding is normally very close to target, but container/audio
      // overhead can still push a borderline file over 16MB. Retry once with
      // extra headroom instead of making staff manually re-export the video.
      await fsApi.unlink(outputPath).catch(() => {});
      plan = bitratePlan(durationSeconds, {
        targetBytes: Math.floor(targetBytes * 0.85),
      });
      await transcodeFn(inputPath, outputPath, plan);
      outputStat = await fsApi.stat(outputPath);
    }

    if (outputStat.size <= 0 || outputStat.size > maxWhatsAppBytes) {
      throw followUpVideoError(
        "The video could not be reduced below WhatsApp's 16MB limit. Please try a shorter or lower-resolution video.",
        "FOLLOW_UP_VIDEO_STILL_TOO_LARGE"
      );
    }

    return {
      buffer: await fsApi.readFile(outputPath),
      compressed: true,
      durationSeconds,
      originalBytes: sourceBytes,
      storedBytes: outputStat.size,
    };
  } finally {
    await fsApi.unlink(outputPath).catch(() => {});
    release();
  }
}

module.exports = {
  MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
  MAX_WHATSAPP_VIDEO_BYTES,
  TARGET_WHATSAPP_VIDEO_BYTES,
  parseFfmpegDuration,
  bitratePlan,
  createCompressionQueue,
  probeDurationSeconds,
  transcodeTwoPass,
  prepareFollowUpVideoFile,
};
