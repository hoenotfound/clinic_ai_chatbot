const test = require("node:test");
const assert = require("node:assert/strict");

const { convertToInstagramAudio } = require("../src/services/audioConvertService");

function makeSilentWav({ sampleRate = 8000, durationMs = 100 } = {}) {
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

test("Instagram voice conversion produces AAC in an M4A container", async () => {
  const result = await convertToInstagramAudio(makeSilentWav(), "audio/wav");

  assert.ok(result, "expected FFmpeg conversion to succeed");
  assert.equal(result.mimeType, "audio/mp4");
  assert.equal(result.filename, "voice.m4a");
  assert.ok(result.buffer.length > 12);
  assert.equal(result.buffer.subarray(4, 8).toString("ascii"), "ftyp");
});
