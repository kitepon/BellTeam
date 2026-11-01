export function createAvatarEditor({ fileInput, preview, cropEditor, canvas, zoom, nameInput, colorInput = null, fallback, error, previewClass = 'avatar owner-avatar', applyAvatar, initials, escapeClass }) {
  const context = canvas.getContext('2d')
  let avatarData = ''
  let changed = false
  let crop = null
  let drag = null
  let readGeneration = 0

  fileInput.addEventListener('change', readFile)
  zoom.addEventListener('input', zoomImage)
  zoom.addEventListener('change', syncPreview)
  canvas.addEventListener('pointerdown', startDrag)
  canvas.addEventListener('pointermove', moveImage)
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  nameInput.addEventListener('input', updatePreview)
  colorInput?.addEventListener('change', updatePreview)

  return {
    reset(value = '') {
      readGeneration++
      avatarData = value?.startsWith('data:image/') || value?.startsWith('/api/bots/') ? value : ''
      changed = false
      crop = null
      drag = null
      fileInput.value = ''
      cropEditor.hidden = true
      updatePreview()
    },
    cancelRead() { readGeneration++ },
    value() { return avatarData },
    changed() { return changed },
  }

  async function readFile() {
    const [file] = fileInput.files
    if (!file) return
    const generation = ++readGeneration
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
      zoom.value = '1'
      cropEditor.hidden = false
      draw()
      syncPreview()
    } catch {
      if (generation === readGeneration) error.textContent = 'この画像は読み込めませんでした。'
    } finally {
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
    updatePreview()
    return avatarData
  }
}

