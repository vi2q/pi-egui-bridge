/**
 * Stub for `@earendil-works/pi-coding-agent` used by the smoke test loader.
 * Only the two API surface members the extension imports are provided.
 */

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

export function resizeImage(raw, _mimeType, options) {
  void raw;
  const maxBytes = options?.maxBytes ?? 250_000;
  // Simulate a compressed result well under the cap so the inline path runs.
  const data = JPEG_HEADER.toString("base64").repeat(8);
  if (data.length > maxBytes) return null;
  return Promise.resolve({
    data,
    mimeType: "image/jpeg",
    width: 1280,
    height: 800,
    original: { width: 1440, height: 900, mimeType: "image/png" },
  });
}

export function formatDimensionNote(resized) {
  if (!resized || !resized.original) return "";
  return `[Image: original ${resized.original.width}x${resized.original.height}, displayed at ${resized.width}x${resized.height}.]`;
}
