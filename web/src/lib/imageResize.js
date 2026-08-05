// Downscales a photo client-side before it ever hits Storage — phone cameras routinely produce
// 3-8MB files at resolutions no thumbnail or lightbox in this app needs. Skips anything already
// smaller than maxDimension so a small/pre-optimized image is never re-encoded for nothing.
// imageOrientation: "from-image" matters here — without it, canvas drawImage ignores the EXIF
// orientation tag and portrait phone photos taken in certain grips come out rotated.
export async function resizeImage(file, { maxDimension = 1600, quality = 0.82 } = {}) {
  if (!file.type.startsWith("image/")) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) {
    bitmap.close?.();
    return file;
  }
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.(png|jpe?g|webp)$/i, ".jpg"), { type: "image/jpeg" });
}
