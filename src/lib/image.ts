/**
 * Downscale a photo before sending it to the local model. Phone photos are 12MP+;
 * the vision encoder doesn't need that, and smaller images keep an 8 GB laptop responsive.
 */
export async function fileToModelImage(file: File, maxSide = 1280): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`)
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process the image.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
