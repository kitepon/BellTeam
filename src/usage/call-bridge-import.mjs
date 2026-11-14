// Bridge's public export (bd09: `python3 scripts/export_connection.py --json`) -> the callBridge settings update input.
// The body's entry (bd10) pipes the export bytes here and hands the result to the live FeatureSettings.update
// with allowSecretValues, so headers/socket/CLI registration follow the existing onChange path.
const invalid = () => Object.assign(new Error('通話ブリッジの接続の書き出しの形式が正しくありません。'), { code: 'CALL_BRIDGE_IMPORT_INVALID' })
export function callBridgeSettingsInput(bytes) {
  let value
  try { value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)) } catch { throw invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'schema,token,url'
    || value.schema !== 'call-bridge.connection.v1' || typeof value.url !== 'string' || typeof value.token !== 'string'
    || !/^[\x21-\x7e]+$/u.test(value.token)) throw invalid()
  let url
  try { url = new URL(value.url) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/mcp')) throw invalid()
  return { enabled: true, values: { url: value.url, token: value.token } }
}
