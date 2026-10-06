import test from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_CHUNK_SIZE,
  parseMessageId,
  parseSingleRange,
  inferMimeType,
  inferFilename,
  safeAsciiFilename,
} from "../src/pure.js";

const document = {
  mimeType: "audio/mp4",
  size: 23 * 1024 * 1024,
  attributes: [
    { className: "DocumentAttributeFilename", fileName: "Episode 7.m4a" },
  ],
};

test("parseMessageId accepts only positive safe integers", () => {
  assert.equal(parseMessageId("7"), 7);
  assert.equal(parseMessageId("0"), null);
  assert.equal(parseMessageId("-1"), null);
  assert.equal(parseMessageId("7.5"), null);
  assert.equal(parseMessageId("abc"), null);
});

test("range without header is capped to the worker media chunk size", () => {
  const range = parseSingleRange("", document.size);
  assert.equal(range.start, 0);
  assert.equal(range.end, MEDIA_CHUNK_SIZE - 1);
  assert.equal(range.length, MEDIA_CHUNK_SIZE);
  assert.equal(range.partial, true);
});

test("bounded explicit range is returned exactly", () => {
  const range = parseSingleRange("bytes=1048576-2097151", document.size);
  assert.deepEqual(range, {
    start: 1048576,
    end: 2097151,
    length: 1048576,
    partial: true,
    requested: true,
  });
});

test("explicit range is capped without changing its start", () => {
  const range = parseSingleRange("bytes=0-1048575", document.size);
  assert.equal(range.start, 0);
  assert.equal(range.length, MEDIA_CHUNK_SIZE);
  assert.equal(range.end, MEDIA_CHUNK_SIZE - 1);
});

test("open-ended range is capped", () => {
  const range = parseSingleRange("bytes=2097152-", document.size);
  assert.equal(range.start, 2097152);
  assert.equal(range.length, MEDIA_CHUNK_SIZE);
  assert.equal(range.end, 2097152 + MEDIA_CHUNK_SIZE - 1);
});

test("suffix range is supported", () => {
  const range = parseSingleRange("bytes=-100000", document.size);
  assert.equal(range.length, 100000);
  assert.equal(range.end, document.size - 1);
  assert.equal(range.start, document.size - 100000);
});

test("invalid and multi-range headers are rejected", () => {
  assert.equal(parseSingleRange("items=0-10", document.size).error, "invalid-unit");
  assert.equal(parseSingleRange("bytes=0-1,2-3", document.size).error, "multiple-or-empty-range");
  assert.equal(parseSingleRange("bytes=999999999-", document.size).error, "unsatisfiable");
});

test("mime and filenames remain usable", () => {
  assert.equal(inferMimeType(document, "audio"), "audio/mp4");
  assert.equal(inferFilename(document, "audio"), "Episode 7.m4a");
  const safe = safeAsciiFilename("\u0ba4\u0bae\u0bbf\u0bb4\u0bcd Episode 7.m4a", "audio.m4a");
  assert.equal(safe.endsWith(" Episode 7.m4a"), true);
  assert.match(safe, /^[\x20-\x7E]+$/);
});
