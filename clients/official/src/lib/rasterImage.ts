export const RASTER_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type RasterImageMimeType = typeof RASTER_IMAGE_MIME_TYPES[number]

export function isRasterImageMimeType(value: string): value is RasterImageMimeType {
  return RASTER_IMAGE_MIME_TYPES.some((mediaType) => mediaType === value)
}

export function rasterImageMimeType(bytes: Uint8Array): RasterImageMimeType | null {
  if (bytes.length >= 8
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff) return 'image/jpeg'
  const header = bytes.length >= 6 ? String.fromCharCode(...bytes.subarray(0, 6)) : ''
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return null
}
