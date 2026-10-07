const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const ffmpegPath = require("ffmpeg-static");

const MIB = 1024 * 1024;
const MAX_WHATSAPP_VIDEO_BYTES = 16 * MIB;
const MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES = MAX_WHATSAPP_VIDEO_BYTES;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

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

function parseFfmpegMediaInfo(stderr) {
  const text = String(stderr || "");
  const videoMatch = text.match(/Stream #[^\n]*Video:\s*([A-Za-z0-9_]+)/i);
  const audioMatch = text.match(/Stream #[^\n]*Audio:\s*([A-Za-z0-9_]+)/i);
  return {
    durationSeconds: parseFfmpegDuration(text),
    videoCodec: videoMatch?.[1]?.toLowerCase() || null,
    audioCodec: audioMatch?.[1]?.toLowerCase() || null,
  };
}

function isWhatsAppSafeVideoInfo(info) {
  const videoCodec = String(info?.videoCodec || "").toLowerCase();
  const audioCodec = String(info?.audioCodec || "").toLowerCase();
  const safeVideo = videoCodec === "h264" || videoCodec === "avc1";
  const safeAudio =
    !audioCodec ||
    audioCodec === "aac" ||
    audioCodec === "mp4a";
  return safeVideo && safeAudio;
}

function probeVideoInfo(
  inputPath,
  {
    spawnFn = spawn,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {}
) {
  if (!ffmpegPath) {
    return Promise.reject(
      followUpVideoError(
        "Video compatibility checking is unavailable on this server.",
        "VIDEO_VALIDATION_UNAVAILABLE"
      )
    );
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(
        ffmpegPath,
        [
          "-hide_banner",
          "-nostdin",
          "-threads", "1",
          "-i", inputPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
    } catch (error) {
      reject(error);
      return;
    }

    let stderr = "";
    let settled = false;
    let timeoutError = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timeoutError = followUpVideoError(
        "The video took too long to inspect. Please export it again as a standard H.264 MP4.",
        "INVALID_FOLLOW_UP_VIDEO"
      );
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => settle(timeoutError || error));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 128 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("close", () => {
      if (timeoutError) {
        settle(timeoutError);
        return;
      }
      const info = parseFfmpegMediaInfo(stderr);
      if (!info.durationSeconds || !info.videoCodec) {
        settle(
          followUpVideoError(
            "This video could not be validated. Please export it again as an H.264 MP4 with AAC audio.",
            "INVALID_FOLLOW_UP_VIDEO"
          )
        );
        return;
      }
      settle(null, info);
    });
  });
}

async function prepareFollowUpVideoFile(
  inputPath,
  {
    originalBytes = null,
    fsApi = fs,
    probeVideoInfoFn = probeVideoInfo,
    maxUploadBytes = MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
    maxWhatsAppBytes = MAX_WHATSAPP_VIDEO_BYTES,
    ensureWhatsAppCompatible = false,
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

  const hardLimit = Math.min(maxUploadBytes, maxWhatsAppBytes);
  if (sourceBytes > hardLimit) {
    throw followUpVideoError(
      "This video is larger than 16MB. Automatic video compression is disabled to keep the chatbot server stable. Please compress or export it before uploading.",
      "WHATSAPP_VIDEO_TOO_LARGE"
    );
  }

  let sourceInfo = null;
  if (ensureWhatsAppCompatible) {
    sourceInfo = await probeVideoInfoFn(inputPath);
    if (!isWhatsAppSafeVideoInfo(sourceInfo)) {
      const videoCodec = sourceInfo.videoCodec || "unknown";
      const audioCodec = sourceInfo.audioCodec || "none";
      throw followUpVideoError(
        `WhatsApp cannot send this video's codec (video: ${videoCodec}, audio: ${audioCodec}). Please export it as H.264 video with AAC audio in an MP4 file. Automatic conversion is disabled on this server.`,
        "WHATSAPP_VIDEO_CODEC_UNSUPPORTED"
      );
    }
  }

  const buffer = await fsApi.readFile(inputPath);
  return {
    buffer,
    compressed: false,
    transcoded: false,
    durationSeconds: sourceInfo?.durationSeconds || null,
    sourceVideoCodec: sourceInfo?.videoCodec || null,
    sourceAudioCodec: sourceInfo?.audioCodec || null,
    originalBytes: sourceBytes,
    storedBytes: sourceBytes,
  };
}

module.exports = {
  MAX_FOLLOW_UP_VIDEO_UPLOAD_BYTES,
  MAX_WHATSAPP_VIDEO_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  parseFfmpegDuration,
  parseFfmpegMediaInfo,
  isWhatsAppSafeVideoInfo,
  probeVideoInfo,
  prepareFollowUpVideoFile,
};
