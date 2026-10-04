/**
 * Downscale a photo before sending it to the local model. Phone photos are 12MP+;
 * the vision encoder doesn't need that, and smaller images keep an 8 GB laptop responsive.
 */
export async function fileToModelImage(file: File, rotation = 0, maxSide = 1600): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`)
  // 1600px: on a real handwritten prescription 1280px lost whole lines; 1600px kept them.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const quarter = ((rotation % 360) + 360) % 360
  const sideways = quarter === 90 || quarter === 270
  const canvas = document.createElement('canvas')
  canvas.width = sideways ? h : w
  canvas.height = sideways ? w : h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process the image.')
  // A sideways photo makes the model invent medicines, so the person can rotate it upright first.
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((quarter * Math.PI) / 180)
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}
