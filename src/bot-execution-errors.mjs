export function stoppedError() {
  const error = new Error('メンバーの動作を停止しました。')
  error.code = 'BOT_STOPPED'
  return error
}
