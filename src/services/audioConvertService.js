const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Converts an audio buffer to MP3 — WhatsApp voice notes arrive as Ogg/Opus,
 * which Safari (desktop and iOS) cannot decode at all, so playing one back
 * in the Inbox on Safari shows a broken "unsupported format" placeholder.
 * MP3 plays in every major browser. Used only for what gets *stored and
 * played back* in the Inbox — transcription (transcriptionService.js) uses
 * the original Ogg/Opus buffer directly, since Gemini has no trouble with it.
 * @param {Buffer} inputBuffer
 * @returns {Promise<{buffer: Buffer, mimeType: string}|null>} null if conversion fails
 */
async function convertToMp3(inputBuffer) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath = path.join(tmpDir, `${id}-in.ogg`);
  const outputPath = path.join(tmpDir, `${id}-out.mp3`);

  try {
    await fs.writeFile(inputPath, inputBuffer);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec("libmp3lame")
        .audioBitrate("64k") // voice notes are speech, not music — keeps file (and DB row) small
        .format("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    const buffer = await fs.readFile(outputPath);
    return { buffer, mimeType: "audio/mpeg" };
  } catch (err) {
    console.error("Audio conversion to MP3 failed:", err);
    return null;
  } finally {
    // Best-effort cleanup — one of these may never have been created if an
    // earlier step failed, so ignore errors here.
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

module.exports = { convertToMp3 };
