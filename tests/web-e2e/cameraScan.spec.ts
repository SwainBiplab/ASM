import { expect, test } from '@playwright/test'
import { E2E_ADMIN } from './accounts'
import { goTo, signIn, uniq } from './helpers'

/**
 * Camera QR scanning (TAS §8.2/U5) is capability-gated on `getUserMedia` only; decoding itself
 * uses `jsqr` (pure JS over canvas pixel data), which works wherever a camera stream does, unlike
 * the native Barcode Detection API this replaced (absent from this Chromium build and from real
 * desktop Chrome/Firefox/Safari in practice -- confirmed the hard way when a user hit exactly
 * that gap). The fake-device flags below only matter for the "opens without erroring" test; the
 * actual decode test replaces the camera stream with a canvas rendering the app's own real QR
 * label output, so `jsqr` decodes genuine QR pixels, not a stub standing in for one.
 */
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
})

async function registerAsset(page: import('@playwright/test').Page, categoryName: string, code: string, serial: string) {
  await goTo(page, 'Asset catalogue')
  await page.getByRole('button', { name: 'Add category' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(categoryName)
  await dialog.getByLabel('Code').fill(code)
  await dialog.getByRole('button', { name: /Add category|Save/ }).click()
  await expect(dialog).toHaveCount(0)

  await goTo(page, 'Assets')
  await page.getByRole('button', { name: 'Add asset' }).click()
  await dialog.getByLabel('Category').selectOption({ label: categoryName })
  await dialog.getByLabel('Manufacturer').fill('Dell')
  await dialog.getByLabel('Model name').fill('Latitude 5420')
  await dialog.getByLabel(/^Serial number/).fill(serial)
  await dialog.getByRole('button', { name: 'Register asset' }).click()
  await expect(dialog).toHaveCount(0)
  const assetCode = (await page.getByText(/AST-\d{6} was registered\./).textContent())!.match(/AST-\d{6}/)![0]
  const assetId = page.url().split('/').pop()!
  return { assetCode, assetId }
}

test('decodes a real QR label and resolves the same asset a USB scan would', async ({ page }) => {
  const p = uniq()
  await signIn(page, E2E_ADMIN)
  const { assetCode, assetId } = await registerAsset(page, `Camera Scan ${p}`, `CAM${p}`.slice(0, 20), `CAM-${p}`)

  // Fetch the asset's real QR label (the exact same SVG a printed label would use), render it to a
  // canvas, and hand getUserMedia that canvas's stream instead of a real camera -- so jsQR below
  // decodes genuine QR pixels produced by the app's own label-generation code, not a stand-in.
  await page.evaluate(async (id) => {
    const res = await fetch('/api/v1/rpc/assets.generateLabels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bpoam-request': '1' },
      body: JSON.stringify({ assetIds: [id] })
    })
    const body = (await res.json()) as { data: Array<{ qrDataUrl: string }> }
    const qrDataUrl = body.data[0]!.qrDataUrl
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('QR image failed to load'))
      img.src = qrDataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || 300
    canvas.height = img.naturalHeight || 300
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const stream = canvas.captureStream(5)
    navigator.mediaDevices.getUserMedia = async () => stream
  }, assetId)

  await goTo(page, 'Scan / find asset')
  await page.getByRole('button', { name: /Scan with camera/ }).click()
  await expect(page.getByRole('heading', { name: `Result for "BPOAM:ASSET:${assetId}"` })).toBeVisible()
  await expect(page.getByText(assetCode, { exact: true })).toBeVisible()
  // The camera stops itself once a code is found; nothing was mutated by the scan.
  await expect(page.locator('.scan-camera__video')).toHaveCount(0)
})

test('opens a real camera stream and tears it down cleanly without erroring', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Scan / find asset')
  await page.getByRole('button', { name: /Scan with camera/ }).click()
  await expect(page.locator('.scan-camera__video')).toBeVisible()
  // The fake device's synthetic test pattern has no real QR in it, so nothing resolves; confirm the
  // draw-to-canvas/decode loop runs repeatedly against it without throwing before stopping manually.
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Stop camera' }).click()
  await expect(page.locator('.scan-camera__video')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('camera scanning is hidden entirely when the browser lacks the capability', async ({ page }) => {
  await page.addInitScript(() => {
    // `mediaDevices` is inherited via the Navigator prototype, so `delete` on the instance is a
    // no-op; redefine it directly to simulate a browser with no camera API at all.
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })
  await signIn(page, E2E_ADMIN)
  await goTo(page, 'Scan / find asset')
  await expect(page.getByRole('button', { name: /Scan with camera/ })).toHaveCount(0)
  await expect(page.getByText(/Camera scanning isn't available/)).toBeVisible()
})
