// Image format and pixel size read from the file's own header — the upload's
// Content-Type is a claim, the magic bytes are the fact. PNG, JPEG and WebP
// only, the three formats a capture arrives in; no decoder dependency.

/** @returns {{mediaType: string, width: number, height: number} | null} null when not a readable image */
export function imageHead(buf) {
  const head = png(buf) ?? jpeg(buf) ?? webp(buf);
  return head && head.width > 0 && head.height > 0 ? head : null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The first chunk is always IHDR: width and height as big-endian u32.
function png(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { mediaType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Walk the marker segments to the first start-of-frame. SOF0..SOF15 carry the
// size, except C4 (DHT), C8 (reserved) and CC (DAC), which share the range.
function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2; // standalone marker, no length
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (i + 9 > buf.length) return null;
      return { mediaType: "image/jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

// RIFF....WEBP, then one of three first chunks with the size in its own place.
function webp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("latin1", 12, 16);
  const type = "image/webp";
  if (chunk === "VP8 ") {
    // lossy: frame tag (3) + start code 9d 01 2a, then 14-bit width/height
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { mediaType: type, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // lossless: signature 0x2f, then width-1 and height-1 packed in 14 bits each
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { mediaType: type, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // extended: canvas width-1 and height-1 as 24-bit little-endian
    return { mediaType: type, width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}
