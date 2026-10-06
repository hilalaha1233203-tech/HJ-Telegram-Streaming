export const MEDIA_CHUNK_SIZE = 512 * 1024;
export const MEDIA_TICKET_TTL_MS = 5 * 60 * 1000;
export const MEDIA_CACHE_TTL = 31_536_000;
export const MEDIA_METADATA_TTL_MS = 5 * 60 * 1000;
export const MAX_METADATA_CACHE = 128;

export function parseMessageId(raw) {
  const value = Number(String(raw ?? "").trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseSingleRange(header, size, maxBytes = MEDIA_CHUNK_SIZE) {
  const fileSize = Number(size);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    return { error: "invalid-size" };
  }

  const raw = String(header ?? "").trim();
  if (!raw) {
    const length = Math.min(fileSize, maxBytes);
    return {
      start: 0,
      end: length - 1,
      length,
      partial: fileSize > length,
      requested: false,
    };
  }

  if (!raw.toLowerCase().startsWith("bytes=")) {
    return { error: "invalid-unit" };
  }

  const spec = raw.slice(6).trim();
  if (!spec || spec.includes(",")) {
    return { error: "multiple-or-empty-range" };
  }

  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) {
    return { error: "invalid-range" };
  }

  const [, left, right] = match;
  let start;
  let end;

  if (!left && !right) {
    return { error: "invalid-range" };
  }

  if (!left) {
    const suffixLength = Number(right);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { error: "unsatisfiable" };
    }
    const length = Math.min(suffixLength, fileSize, maxBytes);
    start = fileSize - length;
    end = fileSize - 1;
  } else {
    start = Number(left);
    if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize) {
      return { error: "unsatisfiable" };
    }
    end = right ? Number(right) : fileSize - 1;
    if (!Number.isSafeInteger(end) || end < start) {
      return { error: "unsatisfiable" };
    }
    end = Math.min(end, fileSize - 1, start + maxBytes - 1);
  }

  const length = end - start + 1;
  return {
    start,
    end,
    length,
    partial: true,
    requested: true,
  };
}

export function normalizeOriginList(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function inferMimeType(document, routeKind) {
  const explicit = String(document?.mimeType || "").trim().toLowerCase();
  if (explicit && explicit !== "application/octet-stream") return explicit;

  const filename = String(
    (document?.attributes || []).find(
      (attr) => attr?.className === "DocumentAttributeFilename"
    )?.fileName || ""
  ).toLowerCase();

  const byExtension = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg; codecs=opus",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
  };

  for (const [ext, mime] of Object.entries(byExtension)) {
    if (filename.endsWith(ext)) return mime;
  }

  if (routeKind === "video") return "video/mp4";
  if (routeKind === "document") return "application/octet-stream";
  return "audio/mp4";
}

export function inferFilename(document, routeKind) {
  const raw = String(
    (document?.attributes || []).find(
      (attr) => attr?.className === "DocumentAttributeFilename"
    )?.fileName || ""
  ).trim();

  if (raw) return raw;
  if (routeKind === "video") return "video.mp4";
  if (routeKind === "document") return "document";
  return "audio.m4a";
}

export function safeAsciiFilename(name, fallback) {
  const ascii = String(name || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\r\n]/g, "_")
    .trim();
  return ascii || fallback;
}

export function encodeDispositionFilename(name) {
  return encodeURIComponent(String(name || "media")).replace(
    /['()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
}

export function errorPayload(code, error = "") {
  const normalized = String(error || "").replace(/[\r\n]+/g, " ").slice(0, 180);
  return normalized ? { error: code, detail: normalized } : { error: code };
}
