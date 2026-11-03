// User cancellation is separate from close() after an accepted save.
export function guardEditorClose(dialog, isDirty, isSaving = () => false) {
  dialog.addEventListener('cancel', event => {
    if ((isDirty() || isSaving()) && !globalThis.confirm(isSaving()
      ? '保存処理中です。閉じても処理は続きます。保存結果は開き直して確認してください。閉じますか？'
      : '未保存の変更を破棄して閉じますか？')) event.preventDefault()
  })
  globalThis.addEventListener?.('beforeunload', event => {
    if (dialog.open && (isDirty() || isSaving())) { event.preventDefault(); event.returnValue = '' }
  })
}

export function requestEditorClose(dialog) {
  if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close()
}
