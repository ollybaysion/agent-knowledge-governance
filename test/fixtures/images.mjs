// Smallest byte strings each format's header reader accepts — imageHead only
// reads headers, so a test image needs no pixel data. `pad` grows the buffer
// (the size-limit test) without changing what the header says.
export function pngBytes(width, height, pad = 0) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// SOI, an APP0 segment to walk past, then SOF0 with height before width.
export function jpegBytes(width, height) {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

export function webpBytes(chunk, width, height) {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write(chunk, 12, "latin1");
  if (chunk === "VP8 ") {
    b.set([0x9d, 0x01, 0x2a], 23);
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    b[20] = 0x2f;
    b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  } else {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  }
  return b;
}
