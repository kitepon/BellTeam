import { modelChoices } from './view-format.js?v=__ASSET_VERSION__'
const harnesses = [['claude','Claude'],['codex','Codex'],['grok','Grok'],['cursor','Cursor'],['antigravity','Antigravity']]
const exact = (value, keys) => value && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key))
function validRecord(value) {
  if (!exact(value,['revision','selection'])) return false
  if (value.revision === null) return value.selection === null
  const choice = value.selection
  return typeof value.revision === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(value.revision)
    && exact(choice,['harness','model','reasoningEffort']) && harnesses.some(([id]) => id === choice.harness)
    && typeof choice.model === 'string' && choice.model.length > 0 && typeof choice.reasoningEffort === 'string'
}
// 考える深さ。値は保存のまま、見せる言葉だけを変える。知らない値はそのまま。
export const effortLabel = value => ({ minimal:'最小', low:'低い', medium:'普通', high:'高い', xhigh:'とても高い', max:'最大' })[value] ?? value
const same = (a,b) => a && b && ['harness','model','reasoningEffort'].every(key => a[key] === b[key])

const UNAVAILABLE = 'この版では、要約を書くAIを選べません。'
// 選んでいる値を、表示名だけで言う（設定のホームの一行）。
function summaryText(opened) {
  if (!opened?.record) return opened?.failure ? '確認できません' : '確認しています'
  const choice = opened.record.selection
  if (!choice) return 'まだ選んでいません'
  const name = harnesses.find(([id]) => id === choice.harness)?.[1] ?? choice.harness
  const entry = opened.models?.[choice.harness]?.models?.find?.(item => item?.id === choice.model)
  return [name, entry ? (entry.display_name || entry.id) : '', choice.reasoningEffort ? effortLabel(choice.reasoningEffort) : 'AIの標準'].filter(Boolean).join(' · ')
}

export function createBackgroundAgentSettings(root, api, { onChange = () => {} } = {}) {
  const find = name => root.querySelector(`[data-background-${name}]`)
  const harness=find('harness'), model=find('model'), effort=find('effort'), save=find('save'), reload=find('reload'), modelReload=find('models-reload')
  const saved=find('saved'), status=find('status'), error=find('error')
  let active = null
  function options(select, values, value) {
    select.replaceChildren(...values.map(([id,label]) => Object.assign(document.createElement('option'), {value:id,textContent:label})))
    select.value = value
  }
  function candidates(opened) {
    const entry=opened.models?.[opened.draft.harness]
    return entry && !entry.error && Array.isArray(entry.models) && entry.models.every(item => item && typeof item.id === 'string' && item.id.length > 0 && Array.isArray(item.efforts) && item.efforts.every(value=>typeof value === 'string' && value)) ? entry.models : []
  }
  function render() {
    const opened=active
    if (!opened) return
    const draft=opened.draft, models=candidates(opened), selected=models.find(item=>item.id === draft.model)
    options(harness, [['','AIを選択'],...harnesses], draft.harness)
    const modelOptions=[['','モデルを選択'],...modelChoices(models)]
    // 候補を読み終えるまでは、保存した値を判定しない。
    if (draft.model && !selected) modelOptions.push([draft.model, opened.modelsLoading || !opened.models ? '保存したモデル（読み込み中）' : '保存したモデル（いまは選べません）'])
    options(model,modelOptions,draft.model)
    const efforts=selected?.efforts ?? [], effortOptions=selected && !efforts.length ? [['','AIの標準']] : [['','考える深さを選択'],...efforts.map(value=>[value,effortLabel(value)])]
    if (draft.reasoningEffort && !efforts.includes(draft.reasoningEffort)) effortOptions.push([draft.reasoningEffort,`${effortLabel(draft.reasoningEffort)}（いまは選べません）`])
    options(effort,effortOptions,draft.reasoningEffort)
    harness.disabled = !opened.known || opened.saving
    model.disabled = harness.disabled || !models.length
    effort.disabled = harness.disabled || !selected || !efforts.length
    save.disabled = harness.disabled || !selected || (efforts.length ? !efforts.includes(draft.reasoningEffort) : draft.reasoningEffort !== '')
    reload.disabled = opened.saving
    // 読み直しのボタンは、読めなかった時だけ、その文の隣に出す。
    reload.hidden = !opened.failure || !opened.known && opened.failure === UNAVAILABLE
    modelReload.disabled = opened.modelsLoading || opened.saving
    const unavailable=draft.harness && opened.models && !models.length && !opened.modelsLoading ? 'このAIのモデルの候補を読めませんでした。「候補を読み直す」を押してください。' : ''
    modelReload.hidden = !opened.modelsFailure && !unavailable
    saved.textContent = summaryText(opened)
    save.textContent = opened.saving ? '保存しています…' : '保存'
    status.textContent = opened.saving ? '' : opened.message
    error.textContent = [opened.failure,opened.modelsFailure,unavailable,draft.model && !selected && opened.models && !opened.modelsLoading ? '保存したモデルは、いまは選べません。選び直して保存してください。' : ''].filter(Boolean).join(' ')
    onChange(summaryText(opened))
  }
  async function refresh(message='') {
    const opened=active
    if (!opened) return
    const read=++opened.read
    try {
      const result=await api('/api/settings')
      if (active !== opened || read !== opened.read) return
      if (!Object.hasOwn(result,'backgroundAgent')) {
        opened.known=false;opened.failure=UNAVAILABLE;render();return
      }
      if (!validRecord(result.backgroundAgent)) throw Error('INVALID_BACKGROUND_AGENT_SETTINGS')
      opened.record=result.backgroundAgent;opened.known=true;opened.failure=''
      if (!opened.dirty && !opened.saving) opened.draft={harness:'',model:'',reasoningEffort:'',...opened.record.selection}
      if (message) opened.message=message
      render()
    } catch {
      if (active !== opened || read !== opened.read) return
      opened.known=false;opened.failure='いまの設定を読めませんでした。「もう一度読み込む」を押してください。入力は残しています。'
      if (message) opened.message=message
      render()
    }
  }
  async function loadModels() {
    const opened=active
    if (!opened || opened.modelsLoading || opened.saving) return
    opened.modelsLoading=true;opened.modelsFailure='';render()
    try {
      const result=await api('/api/models')
      if (active !== opened) return
      if (!result?.models || typeof result.models !== 'object') throw Error('INVALID_MODELS')
      opened.models=result.models
    } catch { if (active === opened) { opened.models=null;opened.modelsFailure='モデルの候補を読めませんでした。「候補を読み直す」を押してください。' } }
    finally { if (active === opened) { opened.modelsLoading=false;render() } }
  }
  for (const [field,name] of [[harness,'harness'],[model,'model'],[effort,'reasoningEffort']]) field.addEventListener('change',()=>{
    if (!active) return
    active.draft[name]=field.value
    if (name === 'harness') active.draft.model=''
    if (name !== 'reasoningEffort') active.draft.reasoningEffort=''
    active.dirty=true;active.message='まだ保存していません。';render()
  })
  root.addEventListener('submit',async event=>{
    event.preventDefault()
    const opened=active
    if (!opened || save.disabled || opened.saving) return
    const choice={...opened.draft}, body={expectedRevision:opened.record.revision,...choice}
    opened.saving=true;opened.read++;opened.failure='';render()
    let message=''
    try {
      const result=await api('/api/settings/backgroundAgent',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      if (active !== opened) return
      if (!exact(result,['backgroundAgent']) || !validRecord(result.backgroundAgent) || !same(result.backgroundAgent.selection,choice)) throw Error('INVALID_SAVE_RESPONSE')
      opened.record=result.backgroundAgent
      if (same(opened.draft,choice)) opened.dirty=false
      message='保存しました。'
    } catch (failure) {
      if (active !== opened) return
      const said=/^[A-Z0-9_]+$/u.test(failure.message ?? '') ? '' : failure.message ?? ''
      message=failure.status === 409 ? '別の画面で設定が変わりました。いまの設定を読み直したので、選び直して保存してください。'
        : failure.status >= 400 && failure.status < 500 && failure.status !== 408 ? `保存できませんでした。${said}` : `保存できたか確かめています。${said}`
    } finally {
      if (active === opened) { opened.saving=false;opened.message=message;render() }
    }
    if (active !== opened) return
    await refresh(message)
    if (active === opened && opened.known && opened.dirty && same(opened.record.selection,choice)) {
      opened.message='選んだ設定は保存されています。';render()
    }
  })
  reload.addEventListener('click',()=>{ if (!active?.saving) void refresh() })
  modelReload.addEventListener('click',()=>{ void loadModels() })
  return {
    async open() {
      active={record:null,known:false,draft:{harness:'',model:'',reasoningEffort:''},models:null,modelsLoading:false,read:0,saving:false,dirty:false,message:'',failure:'',modelsFailure:''}
      const opened=active
      render();await Promise.all([refresh(),loadModels()])
    },
    close() { active=null }, refresh, summary: () => summaryText(active), dirty:()=>Boolean(active?.dirty), busy:()=>Boolean(active?.saving),
  }
}
