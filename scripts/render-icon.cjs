// Renders assets/icon-source.svg (DeepSeek whale glyph from the Web GUI favicon)
// into app-icon PNGs on a DeepSeek-blue rounded tile with a white whale.
// Usage: electron render-icon.cjs [svgPath] [outDir] [design]
//   design: B = solid DeepSeek blue (#4D6BFE) tile + white whale (default)
// Emits icon-16..icon-256.png plus master-1024.png into outDir.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DSH_BLUE = '#4D6BFE'
const S = 1024
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

const svgSrc = process.argv[2] || path.join(__dirname, '..', 'assets', 'icon-source.svg')
const outDir = process.argv[3] || path.join(os.tmpdir(), 'dsh-desktop-icon-pngs')
const design = (process.argv[4] || 'B').toUpperCase()
if (design !== 'B') {
  console.error('unsupported design: ' + design)
  app.exit(2)
}

function buildHtml(d) {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:transparent">
<svg id="whale" width="1024" height="1024" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
<path d="${d}" fill="#000000"/></svg>
<script>
const S = 1024
window.run = async () => {
  const svgMarkup = new XMLSerializer().serializeToString(document.getElementById('whale'))
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([svgMarkup], { type: 'image/svg+xml' }))
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg load failed')) })

  const mkCv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
  const black = mkCv(S, S)
  const bctx = black.getContext('2d')
  bctx.drawImage(img, 0, 0, S, S)
  const px = bctx.getImageData(0, 0, S, S).data
  let minX = S, minY = S, maxX = -1, maxY = -1
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (px[(y * S + x) * 4 + 3] > 0) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const crop = { sx: minX, sy: minY, sw: maxX - minX + 1, sh: maxY - minY + 1 }
  const aspectH = crop.sh / crop.sw

  const whiteWhale = (() => {
    const c = mkCv(S, S)
    const x = c.getContext('2d')
    x.fillStyle = '#FFFFFF'
    x.fillRect(0, 0, S, S)
    x.globalCompositeOperation = 'destination-in'
    x.drawImage(black, 0, 0)
    return c
  })()

  const fitRect = (s, avail) => {
    let tw = avail, th = avail * aspectH
    if (th > avail) { th = avail; tw = th / aspectH }
    return { x: (s - tw) / 2, y: (s - th) / 2, w: tw, h: th }
  }

  function drawDesign(cv, s) {
    const g = cv.getContext('2d')
    const inset = s * 0.04
    const tile = s - inset * 2
    g.beginPath()
    g.roundRect(inset, inset, tile, tile, s * 0.24)
    g.fillStyle = '${DSH_BLUE}'
    g.fill()
    if (s >= 48) {
      g.strokeStyle = 'rgba(255,255,255,0.2745)'
      g.lineWidth = Math.max(1, s * 0.02)
      g.stroke()
    }
    const rect = fitRect(s, s * (1 - 2 * 0.18))
    g.drawImage(whiteWhale, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.w, rect.h)
  }

  const files = []
  for (const s of ${JSON.stringify(SIZES)}) {
    const cv = mkCv(s, s)
    drawDesign(cv, s)
    files.push({ name: 'icon-' + s + '.png', dataUrl: cv.toDataURL('image/png') })
  }
  const master = mkCv(S, S)
  drawDesign(master, S)
  files.push({ name: 'master-1024.png', dataUrl: master.toDataURL('image/png') })
  return { files }
}
</script></body></html>`
}

app.whenReady().then(async () => {
  const svgText = fs.readFileSync(svgSrc, 'utf8')
  const m = svgText.match(/<path\b[^>]*\sd="([^"]*)"/)
  if (!m) { console.error('no path d= in ' + svgSrc); app.exit(2) }
  const win = new BrowserWindow({
    width: S, height: S, x: -10000, y: -10000, show: true,
    frame: false, transparent: true, skipTaskbar: true,
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(m[1])))
  const res = await win.webContents.executeJavaScript('run()')
  fs.mkdirSync(outDir, { recursive: true })
  for (const f of res.files) fs.writeFileSync(path.join(outDir, f.name), Buffer.from(f.dataUrl.split(',')[1], 'base64'))
  console.log('wrote ' + res.files.length + ' PNGs into ' + outDir)
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
