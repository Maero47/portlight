// Chrome native messaging framing: 4-byte length (native byte order) + UTF-8 JSON.
import os from "node:os";

// Chrome rejects host->browser messages larger than 1 MB.
export const MAX_OUTBOUND = 1024 * 1024;
// Our requests are tiny; anything huge means a broken stream.
export const MAX_INBOUND = 1024 * 1024;

const LE = os.endianness() === "LE";

export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_OUTBOUND) {
    throw new RangeError(`message is ${body.length} bytes, over the ${MAX_OUTBOUND} byte limit`);
  }
  const header = Buffer.alloc(4);
  if (LE) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. push() returns the frames completed by this chunk:
 *   { message } for valid JSON, { error } for unparseable JSON.
 * Throws when a frame header is invalid, since the stream cannot be resynced.
 */
export class Decoder {
  constructor({ maxLength = MAX_INBOUND } = {}) {
    this.buf = Buffer.alloc(0);
    this.maxLength = maxLength;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= 4) {
      const len = LE ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
      if (len > this.maxLength) throw new RangeError(`frame of ${len} bytes exceeds ${this.maxLength}`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      try {
        frames.push({ message: JSON.parse(body) });
      } catch (e) {
        frames.push({ error: e });
      }
    }
    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get pending() {
    return this.buf.length;
  }
}
