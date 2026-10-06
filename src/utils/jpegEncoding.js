// Read JPEG frame metadata without decoding pixels or copying the image.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PROGRESSIVE_MARKERS = new Set([0xc2, 0xc6, 0xca, 0xce]);
function jpegFrameInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (SOF_MARKERS.has(marker)) {
      if (length < 8) return null;
      return {
        encoding: PROGRESSIVE_MARKERS.has(marker) ? "progressive" : "non-progressive",
        precision: bytes[offset + 2],
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
        components: bytes[offset + 7],
      };
    }
    offset += length;
  }
  return null;
}
function jpegFrameEncoding(bytes) {
  return jpegFrameInfo(bytes)?.encoding || null;
}
module.exports = { jpegFrameEncoding, jpegFrameInfo };
