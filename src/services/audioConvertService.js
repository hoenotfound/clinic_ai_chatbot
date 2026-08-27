const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

ffmpeg.setFfmpegPath(ffmpegPath);
const MAX_WHATSAPP_VOICE_SECONDS = 120;

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

function extensionForMimeType(mimeType) {
  const baseType = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const extensions = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
  };
  return extensions[baseType] || ".audio";
}

function runFfmpeg(inputPath, outputPath, configure) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath).noVideo();
    configure(command)
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function inspectOggOpus(buffer) {
  const first4 = buffer.subarray(0, 4).toString("ascii");
  const hasOpusHead = buffer.includes(Buffer.from("OpusHead"));
  return {
    bytes: buffer.length,
    first4,
    first16Hex: buffer.subarray(0, 16).toString("hex"),
    hasOpusHead,
    sha256: sha256(buffer),
    valid: first4 === "OggS" && hasOpusHead,
  };
}

/**
 * Normalizes a browser microphone recording into both formats needed by the
 * app: mono Ogg/Opus for a native WhatsApp voice note, and MP3 for reliable
 * playback in every portal browser (especially Safari).
 *
 * Browsers do not agree on a recording container: Chromium usually gives us
 * WebM/Opus while Safari commonly gives us MP4/AAC. FFmpeg detects and
 * converts either input here, so the client does not need platform-specific
 * upload logic.
 *
 * @param {Buffer} inputBuffer
 * @param {string} inputMimeType
 * @returns {Promise<{
 *   whatsapp: {buffer: Buffer, mimeType: string, filename: string},
 *   playback: {buffer: Buffer, mimeType: string}
 * }|null>}
 */
async function convertToWhatsAppVoice(inputBuffer, inputMimeType) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath = path.join(tmpDir, `${id}-voice-in${extensionForMimeType(inputMimeType)}`);
  const oggPath = path.join(tmpDir, `${id}-voice-out.ogg`);
  const mp3Path = path.join(tmpDir, `${id}-voice-playback.mp3`);

  try {
    await fs.writeFile(inputPath, inputBuffer);

    // Meta requires native voice messages to be mono Ogg with the Opus codec.
    await runFfmpeg(inputPath, oggPath, (command) =>
      command
        .duration(MAX_WHATSAPP_VOICE_SECONDS)
        .audioCodec("libopus")
        .audioChannels(1)
        .audioFrequency(48000)
        .audioBitrate("32k")
        .format("ogg")
    );

    await runFfmpeg(inputPath, mp3Path, (command) =>
      command
        .duration(MAX_WHATSAPP_VOICE_SECONDS)
        .audioCodec("libmp3lame")
        .audioChannels(1)
        .audioBitrate("64k")
        .format("mp3")
    );

    const [whatsappBuffer, playbackBuffer] = await Promise.all([
      fs.readFile(oggPath),
      fs.readFile(mp3Path),
    ]);

    const voiceDiagnostics = inspectOggOpus(whatsappBuffer);
    console.log("[voice-output]", voiceDiagnostics);
    if (!voiceDiagnostics.valid) {
      console.error("Generated WhatsApp voice file is not valid OGG/Opus; refusing to upload it.");
      return null;
    }

    return {
      whatsapp: {
        buffer: whatsappBuffer,
        // Match the exact multipart file Content-Type that succeeded in the
        // independent Meta curl test. Opus is encoded inside the OGG bytes.
        mimeType: "audio/ogg",
        filename: "voice.ogg",
      },
      playback: { buffer: playbackBuffer, mimeType: "audio/mpeg" },
    };
  } catch (err) {
    console.error("Voice-message conversion failed:", err);
    return null;
  } finally {
    await Promise.all([
      fs.unlink(inputPath).catch(() => {}),
      fs.unlink(oggPath).catch(() => {}),
      fs.unlink(mp3Path).catch(() => {}),
    ]);
  }
}

module.exports = { convertToMp3, convertToWhatsAppVoice };