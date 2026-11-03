export function createAvatarEditor({ retainSource = false, onChange = () => {}, fileInput, preview, cropEditor, canvas, zoom, nameInput, colorInput = null, fallback, error, previewClass = 'avatar owner-avatar', applyAvatar, initials, escapeClass }) {
  const context = canvas.getContext('2d')
  let avatarData = ''
  let changed = false
  let sourceData = '', savedRect = null
  let crop = null
  let drag = null
  let readGeneration = 0, reading = false

  fileInput.addEventListener('change', readFile)
  zoom.addEventListener('input', zoomImage)
  zoom.addEventListener('change', syncPreview)
  canvas.addEventListener('pointerdown', startDrag)
  canvas.addEventListener('pointermove', moveImage)
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  canvas.addEventListener('keydown', event => {
    const direction = { ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1] }[event.key]
    if (!crop || !direction) return
    event.preventDefault()
    const step = event.shiftKey ? 16 : 4
    crop.x += direction[0] * step; crop.y += direction[1] * step
    clamp(); syncPreview()
  })
  nameInput.addEventListener('input', updatePreview)
  colorInput?.addEventListener('change', updatePreview)

  return {
    reset(value = '', appearance = {}) {
      sourceData = appearance.source ?? ''
      savedRect = appearance.rect ?? null
      readGeneration++
      reading = false
      avatarData = value?.startsWith('data:image/') || value?.startsWith('/api/bots/') ? value : ''
      changed = false
      crop = null
      drag = null
      fileInput.value = ''
      cropEditor.hidden = true
      updatePreview()
    },
    cancelRead() { readGeneration++; reading = false },
    pending() { return reading },
    value() { return avatarData },
    changed() { return changed },
    source() { return sourceData },
    rectangle() { return savedRect },
    async recrop() {
      if (!sourceData) return
      reading = true
      const generation = ++readGeneration, image = new Image()
      image.src = sourceData
      try {
        await image.decode()
        if (generation !== readGeneration) return
        const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
        const nextScale = savedRect ? canvas.width / (image.naturalWidth * savedRect.width) : scale
        crop = { image, minimumScale:scale, scale:nextScale,
          x:savedRect ? -savedRect.x * image.naturalWidth * nextScale : (canvas.width-image.naturalWidth*scale)/2,
          y:savedRect ? -savedRect.y * image.naturalHeight * nextScale : (canvas.height-image.naturalHeight*scale)/2 }
        zoom.value = String(nextScale / scale)
        cropEditor.hidden = false
        clamp(); draw()
      } catch { if (generation === readGeneration) error.textContent = '保存元の画像を読み込めませんでした。写真を選び直してください。' }
      finally { if (generation === readGeneration) reading = false }
    },
  }

  async function readFile() {
    const [file] = fileInput.files
    if (!file) return
    const generation = ++readGeneration
    reading = true
    const source = URL.createObjectURL(file)
    const image = new Image()
    image.src = source
    try {
      await image.decode()
      if (generation !== readGeneration) return
      const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
      crop = {
        image,
        minimumScale: scale,
        scale,
        x: (canvas.width - image.naturalWidth * scale) / 2,
        y: (canvas.height - image.naturalHeight * scale) / 2,
      }
      if (retainSource) {
        const sourceCanvas = document.createElement('canvas')
        const ratio = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
        sourceCanvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
        sourceCanvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
        sourceCanvas.getContext('2d').drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height)
        for (const quality of [.9, .7, .5, .3]) {
          sourceData = sourceCanvas.toDataURL('image/jpeg', quality)
          if (sourceData.length <= 3_000_000) break
        }
        if (sourceData.length > 3_000_000) throw Error('IMAGE_TOO_LARGE')
      }
      zoom.value = '1'
      cropEditor.hidden = false
      draw()
      syncPreview()
    } catch {
      if (generation === readGeneration) error.textContent = 'この画像は読み込めませんでした。'
    } finally {
      if (generation === readGeneration) reading = false
      URL.revokeObjectURL(source)
    }
  }

  function updatePreview() {
    preview.className = colorInput ? `avatar ${escapeClass(colorInput.value)}` : previewClass
    preview.textContent = initials(nameInput.value || fallback)
    applyAvatar(preview, { avatar: avatarData })
  }

  function zoomImage() {
    if (!crop) return
    const nextScale = crop.minimumScale * Number(zoom.value)
    const ratio = nextScale / crop.scale
    crop.x = canvas.width / 2 - (canvas.width / 2 - crop.x) * ratio
    crop.y = canvas.height / 2 - (canvas.height / 2 - crop.y) * ratio
    crop.scale = nextScale
    clamp()
    draw()
  }

  function startDrag(event) {
    if (!crop) return
    canvas.setPointerCapture(event.pointerId)
    drag = { x: event.clientX, y: event.clientY }
  }

  function moveImage(event) {
    if (!crop || !drag) return
    const ratio = canvas.width / canvas.getBoundingClientRect().width
    crop.x += (event.clientX - drag.x) * ratio
    crop.y += (event.clientY - drag.y) * ratio
    drag = { x: event.clientX, y: event.clientY }
    clamp()
    draw()
  }

  function endDrag() {
    if (!drag) return
    drag = null
    syncPreview()
  }

  function clamp() {
    crop.x = Math.min(0, Math.max(canvas.width - crop.image.naturalWidth * crop.scale, crop.x))
    crop.y = Math.min(0, Math.max(canvas.height - crop.image.naturalHeight * crop.scale, crop.y))
  }

  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(crop.image, crop.x, crop.y, crop.image.naturalWidth * crop.scale, crop.image.naturalHeight * crop.scale)
  }

  function syncPreview() {
    if (!crop) return avatarData
    draw()
    avatarData = canvas.toDataURL('image/jpeg', .9)
    changed = true
    onChange()
    savedRect = { x: -crop.x / (crop.image.naturalWidth * crop.scale), y: -crop.y / (crop.image.naturalHeight * crop.scale),
      width: canvas.width / (crop.image.naturalWidth * crop.scale), height: canvas.height / (crop.image.naturalHeight * crop.scale) }
    updatePreview()
    return avatarData
  }
}

