const harnesses = [['claude','Claude Code'],['codex','Codex'],['grok','Grok'],['cursor','Cursor'],['antigravity','Antigravity']]
const exact = (value, keys) => value && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key))
function validRecord(value) {
  if (!exact(value,['revision','selection'])) return false
  if (value.revision === null) return value.selection === null
  const choice = value.selection
  return typeof value.revision === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(value.revision)
    && exact(choice,['harness','model','reasoningEffort']) && harnesses.some(([id]) => id === choice.harness)
    && typeof choice.model === 'string' && choice.model.length > 0 && typeof choice.reasoningEffort === 'string'
}
const same = (a,b) => a && b && ['harness','model','reasoningEffort'].every(key => a[key] === b[key])

export function createBackgroundAgentSettings(root, api) {
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
    options(harness, [['','ハーネスを選択'],...harnesses], draft.harness)
    const modelOptions=[['','モデルを選択'],...models.map(item=>[item.id,item.id])]
    if (draft.model && !selected) modelOptions.push([draft.model,`${draft.model}（現在の候補にありません）`])
    options(model,modelOptions,draft.model)
    const efforts=selected?.efforts ?? [], effortOptions=selected && !efforts.length ? [['','CLIの既定（エフォート指定なし）']] : [['','エフォートを選択'],...efforts.map(value=>[value,value])]
    if (draft.reasoningEffort && !efforts.includes(draft.reasoningEffort)) effortOptions.push([draft.reasoningEffort,`${draft.reasoningEffort}（現在の候補にありません）`])
    options(effort,effortOptions,draft.reasoningEffort)
    harness.disabled = !opened.known || opened.saving
    model.disabled = harness.disabled || !models.length
    effort.disabled = harness.disabled || !selected || !efforts.length
    save.disabled = harness.disabled || !selected || (efforts.length ? !efforts.includes(draft.reasoningEffort) : draft.reasoningEffort !== '')
    reload.disabled = opened.saving
    modelReload.disabled = opened.modelsLoading || opened.saving
    saved.textContent = opened.record ? opened.record.selection ? `保存済み：${opened.record.selection.harness} / ${opened.record.selection.model} / ${opened.record.selection.reasoningEffort || 'CLIの既定'}` : 'まだ設定されていません。' : '保存済みの設定は未取得です。'
    status.textContent = opened.saving ? '設定を保存しています…' : opened.message
    const unavailable=draft.harness && !models.length && !opened.modelsLoading ? 'このハーネスのモデル候補を取得できません。候補を再取得してください。' : ''
    error.textContent = [opened.failure,opened.modelsFailure,unavailable,draft.model && !selected && !opened.modelsLoading ? '現在の候補にない設定です。候補を再取得して選び直してください。' : ''].filter(Boolean).join(' ')
  }
  async function refresh(message='') {
    const opened=active
    if (!opened) return
    const read=++opened.read
    try {
      const result=await api('/api/settings')
      if (active !== opened || read !== opened.read) return
      if (!Object.hasOwn(result,'backgroundAgent')) {
        opened.known=false;opened.failure='この版では背景エージェントの設定を利用できません。';render();return
      }
      if (!validRecord(result.backgroundAgent)) throw Error('INVALID_BACKGROUND_AGENT_SETTINGS')
      opened.record=result.backgroundAgent;opened.known=true;opened.failure=''
      if (!opened.dirty && !opened.saving) opened.draft={harness:'',model:'',reasoningEffort:'',...opened.record.selection}
      if (message) opened.message=message
      render()
    } catch {
      if (active !== opened || read !== opened.read) return
      opened.known=false;opened.failure='設定を取得できませんでした。入力を保持しています。状態を更新して確認してください。'
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
    } catch { if (active === opened) { opened.models=null;opened.modelsFailure='モデル候補を取得できませんでした。候補を再取得してください。' } }
    finally { if (active === opened) { opened.modelsLoading=false;render() } }
  }
  for (const [field,name] of [[harness,'harness'],[model,'model'],[effort,'reasoningEffort']]) field.addEventListener('change',()=>{
    if (!active) return
    active.draft[name]=field.value
    if (name === 'harness') active.draft.model=''
    if (name !== 'reasoningEffort') active.draft.reasoningEffort=''
    active.dirty=true;active.message='未保存の変更があります。';render()
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
      message='設定を保存しました。要約の生成状況は各メンバーの現在の仕事で確認できます。'
    } catch (failure) {
      if (active !== opened) return
      message=failure.status === 409 ? '別の画面で設定が変更されました。保存済みの設定と入力を確認してください。' : `保存結果を確認しています。${failure.message ?? ''}`
    } finally {
      if (active === opened) { opened.saving=false;opened.message=message;render() }
    }
    if (active !== opened) return
    await refresh(message)
    if (active === opened && opened.known && opened.dirty && same(opened.record.selection,choice)) {
      opened.message='選んだ設定が保存されています。要約の動作は未確認です。';render()
    }
  })
  reload.addEventListener('click',()=>{ if (!active?.saving) void refresh() })
  modelReload.addEventListener('click',()=>{ void loadModels() })
  return {
    async open() {
      active={record:null,known:false,draft:{harness:'',model:'',reasoningEffort:''},models:null,modelsLoading:false,read:0,saving:false,dirty:false,message:'設定を確認しています…',failure:'',modelsFailure:''}
      const opened=active
      render();await Promise.all([refresh(),loadModels()])
      if (active === opened && opened.message === '設定を確認しています…') { opened.message='';render() }
    },
    close() { active=null }, refresh, dirty:()=>Boolean(active?.dirty), busy:()=>Boolean(active?.saving),
  }
}
