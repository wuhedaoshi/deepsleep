import { exportProviderBackup, importProviderBackup } from '../../services/chat/backup.js'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  normalizeConnection,
  openCodeProtocol,
  siliconFlowEfforts,
  type ExternalEffort,
  type OpenCodeProtocol,
  normalizeCustomProvider,
  services,
  type CustomProvider,
  type Service,
} from '../../services/api/connections.js'
import {
  fetchProviderModels,
  type CatalogProvider,
  type ModelCatalog,
} from '../../services/api/modelCatalog.js'
import {
  saveCustomProvider,
  setApiKey,
  setConnection,
  setModel,
  setProviderKey,
  useSettings,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { ApiError } from '../../services/api/client.js'
import { logError } from '../../services/log.js'
import { createId } from '../../utils/id.js'
import styles from './ProviderSettings.module.css'

const labels: Record<Service, TranslationKey> = {
  chat: 'providerChat',
  search: 'providerSearch',
  fetch: 'providerFetch',
  asr: 'providerAsr',
  tts: 'providerTts',
}
export const presetProviderNames = {
  deepseek: 'DeepSeek',
  opencode: 'OpenCode Zen',
  siliconflow: '硅基流动 · SiliconFlow',
  tavily: 'Tavily',
}
type Preset = keyof typeof presetProviderNames
type Provider = Preset | 'custom' | `custom:${string}`
const presets = Object.keys(presetProviderNames) as Preset[]
const isCatalog = (id: Provider): id is CatalogProvider =>
  id === 'deepseek' || id === 'opencode' || id === 'siliconflow'
const isPreset = (id: Provider): id is Preset => isCatalog(id) || id === 'tavily'
type Catalog = { status: 'loading' | 'ready' | 'failed' } & ModelCatalog

const savedKey = (settings: ReturnType<typeof useSettings.getState>, provider: Preset) =>
  provider === 'deepseek'
    ? (settings.apiKey ?? '')
    : (settings.providerKeys[provider] ??
      Object.values(settings.connections).find((item) => item?.provider === provider)?.key ??
      '')

const ProviderCard = ({
  provider,
  catalog,
  refresh,
}: {
  provider: Preset
  catalog?: Catalog
  refresh: (provider: CatalogProvider, key: string) => void
}) => {
  const t = useTranslate()
  const stored = useSettings((state) => savedKey(state, provider))
  const [key, setKey] = useState(stored)
  const [saved, setSaved] = useState(false)
  const normalized = key.trim()
  const invalid = /[^\x21-\x7e]/.test(normalized)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!normalized || invalid) {
      return
    }
    if (provider === 'deepseek') {
      setApiKey(normalized)
    } else {
      setProviderKey(provider, normalized)
    }
    if (isCatalog(provider)) {
      refresh(provider, normalized)
    }
    setSaved(true)
  }
  return (
    <form className={styles.cardForm} onSubmit={submit}>
      <label>
        {t('providerKey')}
        <input
          type="password"
          value={key}
          autoComplete="off"
          onChange={(event) => {
            setKey(event.target.value)
            setSaved(false)
          }}
        />
      </label>
      <div className={styles.actions}>
        <Button
          type="submit"
          size="m"
          disabled={!normalized || invalid || catalog?.status === 'loading'}
        >
          {t(isCatalog(provider) ? 'providerConnect' : 'providerSave')}
        </Button>
        <span role="status">
          {invalid
            ? t('providerInvalid')
            : catalog?.status === 'loading'
              ? t('providerLoading')
              : catalog?.status === 'failed'
                ? t('providerCatalogFailed')
                : catalog?.status === 'ready'
                  ? t('providerCatalogCount', { count: catalog.models.length })
                  : saved || stored
                    ? t('providerSaved')
                    : null}
        </span>
      </div>
    </form>
  )
}

const CustomProviderForm = ({
  value,
  onSave,
  onCancel,
}: {
  value?: CustomProvider
  onSave: (provider: CustomProvider) => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  const [name, setName] = useState(value?.name ?? '')
  const [kind, setKind] = useState<CustomProvider['kind']>(value?.kind ?? 'chat')
  const [base, setBase] = useState(value?.base ?? '')
  const [key, setKey] = useState(value?.key ?? '')
  const [invalid, setInvalid] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const profile = normalizeCustomProvider({
      id: value?.id ?? 'custom:' + createId(),
      name,
      kind,
      base,
      key,
    })
    if (!profile) {
      setInvalid(true)
      return
    }
    onSave(profile)
  }
  return (
    <form className={styles.cardForm} onSubmit={submit}>
      <label>
        {t('providerName')}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={60}
        />
      </label>
      <div className={styles.heading}>
        <span>{t('providerProtocol')}</span>
        <Select
          value={kind}
          onChange={setKind}
          disabled={Boolean(value)}
          ariaLabel={t('providerProtocol')}
          options={[
            { value: 'chat', label: t('providerProtocolChat') },
            { value: 'tools', label: t('providerProtocolTools') },
          ]}
        />
      </div>
      <label>
        {t('providerBase')}
        <input
          type="url"
          value={base}
          onChange={(event) => setBase(event.target.value)}
          placeholder="https://api.example.com/v1"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </label>
      <label>
        {t('providerKey')}
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
        />
      </label>
      <div className={styles.actions}>
        <Button type="submit" size="m">
          {t(kind === 'chat' ? 'providerConnect' : 'providerSave')}
        </Button>
        <Button size="m" variant="outlined" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
      {invalid && <p role="status">{t('providerProfileInvalid')}</p>}
    </form>
  )
}

export const ProviderSettings = () => {
  const t = useTranslate()
  const [provider, setProvider] = useState<Provider>('deepseek')
  const profiles = useSettings((state) => state.customProviders)
  const [editing, setEditing] = useState(false)
  const profile = profiles.find((item) => item.id === provider)
  const [catalogs, setCatalogs] = useState<Partial<Record<string, Catalog>>>({})
  const requests = useRef(new Map<string, AbortController>())
  useEffect(() => {
    const active = requests.current
    return () => active.forEach((controller) => controller.abort())
  }, [])
  const refresh = (source: CatalogProvider | CustomProvider, key: string) => {
    const id = typeof source === 'string' ? source : source.id
    const active = requests.current
    active.get(id)?.abort()
    const controller = new AbortController()
    active.set(id, controller)
    setCatalogs((previous) => ({
      ...previous,
      [id]: { status: 'loading', models: [], routes: {} },
    }))
    void fetchProviderModels(source, key, controller.signal).then(
      (catalog) => {
        if (!controller.signal.aborted) {
          setCatalogs((previous) => ({ ...previous, [id]: { status: 'ready', ...catalog } }))
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          logError('settings', '模型目录同步失败', {
            provider: typeof source === 'string' ? source : 'custom',
            kind: error instanceof ApiError ? error.kind : 'invalid-response',
            status: error instanceof ApiError ? error.status : undefined,
          })
          setCatalogs((previous) => ({
            ...previous,
            [id]: { status: 'failed', models: [], routes: {} },
          }))
        }
      }
    )
  }
  const loadSaved = (id: Provider) => {
    if (catalogs[id] || requests.current.has(id)) {
      return
    }
    const settings = useSettings.getState()
    const profile = settings.customProviders.find((item) => item.id === id)
    if (profile?.kind === 'chat') {
      refresh(profile, profile.key)
    } else if (isCatalog(id)) {
      const key = savedKey(settings, id)
      if (key) {
        refresh(id, key)
      }
    }
  }
  const pick = (id: Provider) => {
    setEditing(false)
    setProvider(id)
    loadSaved(id)
  }
  const saveProfile = (value: CustomProvider) => {
    if (saveCustomProvider(value)) {
      setProvider(value.id as Provider)
      setEditing(false)
      if (value.kind === 'chat') {
        refresh(value, value.key)
      }
    }
  }
  return (
    <section className={styles.group} aria-label={t('providerServices')}>
      <div className={styles.intro}>
        <h3>{t('providerServices')}</h3>
        <p>{t('providerGroupedHint')}</p>
      </div>
      <div className={styles.card}>
        <div className={styles.heading}>
          <h4>{t('providerCredentials')}</h4>
          <Select
            value={provider}
            ariaLabel={t('providerCredentials')}
            onChange={pick}
            options={[
              ...presets.map((value) => ({ value, label: presetProviderNames[value] })),
              ...profiles.map((item) => ({ value: item.id as Provider, label: item.name })),
            ]}
          />
        </div>
        {editing ? (
          <CustomProviderForm
            value={profile}
            key={provider}
            onSave={saveProfile}
            onCancel={() => {
              setEditing(false)
              if (!profile) {
                setProvider('deepseek')
              }
            }}
          />
        ) : isPreset(provider) ? (
          <ProviderCard
            key={provider}
            provider={provider}
            catalog={catalogs[provider]}
            refresh={refresh}
          />
        ) : (
          profile && (
            <div className={styles.cardForm}>
              <p>{profile.base}</p>
              <div className={styles.actions}>
                <Button size="m" variant="outlined" onClick={() => setEditing(true)}>
                  {t('providerEdit')}
                </Button>
                {profile.kind === 'chat' && (
                  <span role="status">
                    {catalogs[provider]?.status === 'loading'
                      ? t('providerLoading')
                      : catalogs[provider]?.status === 'failed'
                        ? t('providerCatalogFailed')
                        : catalogs[provider]?.status === 'ready'
                          ? t('providerCatalogCount', { count: catalogs[provider].models.length })
                          : null}
                  </span>
                )}
              </div>
            </div>
          )
        )}
        {!editing && (
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setProvider('custom')
              setEditing(true)
            }}
          >
            {t('providerAdd')}
          </button>
        )}
      </div>
      <div className={styles.card}>
        <div className={styles.heading}>
          <h4>{t('providerRouting')}</h4>
        </div>
        {services.map((service) => (
          <ServiceRow key={service} service={service} catalogs={catalogs} loadSaved={loadSaved} />
        ))}
      </div>
      <ProviderBackup />
    </section>
  )
}

const ProviderBackup = () => {
  const t = useTranslate()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TranslationKey>()
  const run = async (file?: File) => {
    setBusy(true)
    setResult(undefined)
    try {
      if (file) {
        await importProviderBackup(file)
        setResult('providerBackupImported')
        return
      }
      const outcome = await exportProviderBackup()
      if (outcome.blob) {
        const url = URL.createObjectURL(outcome.blob)
        const link = document.createElement('a')
        link.href = url
        link.download = outcome.name
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      setResult('providerBackupExported')
    } catch {
      setResult('providerBackupFailed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.card}>
      <div className={styles.heading}><h4>{t('providerBackupTitle')}</h4></div>
      <div className={styles.cardForm}>
        <p>{t('providerBackupDescription')}</p>
        <div className={styles.actions}>
          <Button size="m" variant="outlined" disabled={busy} onClick={() => void run()}>
            {t('providerBackupExport')}
          </Button>
          <Button size="m" variant="outlined" disabled={busy} onClick={() => input.current?.click()}>
            {t('providerBackupImport')}
          </Button>
        </div>
        <input
          ref={input}
          hidden
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) {
              void run(file)
            }
          }}
        />
        {result && <p role="status">{t(result)}</p>}
      </div>
    </div>
  )
}

const ServiceRow = ({
  service,
  catalogs,
  loadSaved,
}: {
  service: Service
  catalogs: Partial<Record<string, Catalog>>
  loadSaved: (provider: Provider) => void
}) => {
  const t = useTranslate()
  const stored = useSettings((state) => state.connections[service])
  const deepseekModel = useSettings((state) => state.model)
  const [provider, setProvider] = useState<Provider>(
    ((stored?.profileId ?? stored?.provider) as Provider | undefined) ?? 'deepseek'
  )
  const [base, setBase] = useState(stored?.provider === 'custom' ? stored.base : '')
  const [key, setKey] = useState(stored?.provider === 'custom' ? stored.key : '')
  const [model, setLocalModel] = useState(stored?.model ?? deepseekModel)
  const [manual, setManual] = useState(false)
  const [manualProtocol, setManualProtocol] = useState<OpenCodeProtocol>()
  const [effort, setEffort] = useState<ExternalEffort | 'default'>(stored?.effort ?? 'default')
  const [status, setStatus] = useState<TranslationKey | null>(null)
  const profiles = useSettings((state) => state.customProviders)
  const profile = profiles.find((item) => item.id === provider)
  const accountKey = useSettings((state) => (isPreset(provider) ? savedKey(state, provider) : ''))
  const allowed: Provider[] =
    service === 'chat'
      ? ['deepseek', 'opencode', 'siliconflow', 'custom']
      : service === 'search' || service === 'fetch'
        ? ['deepseek', 'tavily', 'custom']
        : ['deepseek', 'custom']
  allowed.splice(
    allowed.length - 1,
    0,
    ...profiles
      .filter((item) => item.kind === (service === 'chat' ? 'chat' : 'tools'))
      .map((item) => item.id as Provider)
  )
  const catalog = catalogs[provider]
  const models =
    catalog?.status === 'ready' && catalog.models.length
      ? catalog.models
      : provider === 'deepseek'
        ? ['deepseek-flash', 'deepseek-v4-pro']
        : []
  const selected = model || models[0] || ''
  const route = provider === 'opencode' ? catalog?.routes[selected] : undefined
  const protocol =
    route?.protocol ??
    manualProtocol ??
    (stored?.provider === 'opencode' && stored.model === selected ? stored.protocol : undefined) ??
    openCodeProtocol(selected)
  const efforts =
    provider === 'siliconflow'
      ? siliconFlowEfforts(selected)
      : provider === 'opencode' && protocol !== 'messages'
        ? (route?.efforts ??
          (stored?.provider === 'opencode' && stored.model === selected && stored.effort
            ? [stored.effort]
            : []))
        : []
  const name = (id: string) =>
    presetProviderNames[id as Preset] ??
    profiles.find((item) => item.id === id)?.name ??
    t('providerCustom')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (provider === 'deepseek') {
      if (service === 'chat' && (selected === 'deepseek-flash' || selected === 'deepseek-v4-pro')) {
        setModel(selected)
      }
      setConnection(service, null)
    } else {
      if (isPreset(provider) && !accountKey) {
        setStatus('providerKeyRequired')
        return
      }
      const value = {
        provider: profile ? 'custom' : provider,
        profileId: profile?.id,
        base: profile?.base ?? base,
        key: profile?.key ?? (provider === 'custom' ? key : accountKey),
        model: service === 'chat' && provider !== 'custom' && !manual ? selected : model,
        protocol: provider === 'opencode' ? protocol : undefined,
        contextWindow:
          route?.contextWindow ??
          (stored?.provider === provider && stored?.model === selected
            ? stored.contextWindow
            : undefined),
        maxOutput:
          route?.maxOutput ??
          (stored?.provider === provider && stored?.model === selected
            ? stored.maxOutput
            : undefined),
        effort: effort !== 'default' && efforts.includes(effort) ? effort : undefined,
      }
      if (!normalizeConnection(service, value) || !setConnection(service, value)) {
        setStatus('providerInvalid')
        return
      }
    }
    setStatus('providerSaved')
  }
  return (
    <details
      className={styles.row}
      onToggle={(event) => {
        if (event.currentTarget.open && provider !== 'custom') {
          loadSaved(provider)
        }
      }}
    >
      <summary>
        <strong>{t(labels[service])}</strong>
        <span className={styles.current}>
          {name(stored?.profileId ?? stored?.provider ?? 'deepseek')}
        </span>
      </summary>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.heading}>
          <span>{t('providerSelect')}</span>
          <Select
            value={provider}
            ariaLabel={t('providerSelect')}
            options={allowed.map((value) => ({ value, label: name(value) }))}
            onChange={(value) => {
              setProvider(value)
              setLocalModel(
                value === 'deepseek'
                  ? deepseekModel
                  : value === (stored?.profileId ?? stored?.provider)
                    ? (stored?.model ?? '')
                    : ''
              )
              setStatus(null)
              setManual(false)
              setManualProtocol(undefined)
              setEffort('default')
              if (value !== 'custom') {
                loadSaved(value)
              }
            }}
          />
        </div>
        {provider === 'custom' && (
          <>
            <p>
              {t(service === 'chat' ? 'providerChatHint' : 'providerToolHint', { path: service })}
            </p>
            <label>
              {t('providerBase')}
              <input
                type="url"
                value={base}
                required
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBase(event.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              {t('providerKey')}
              <input
                type="password"
                value={key}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
          </>
        )}
        {service === 'chat' &&
          (provider === 'custom' || manual ? (
            <label>
              {t('providerModel')}
              <input
                value={model}
                required
                onChange={(event) => {
                  setLocalModel(event.target.value)
                  setManualProtocol(undefined)
                  setEffort('default')
                }}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          ) : (
            <label>
              {t('providerModel')}
              <select
                value={selected}
                aria-label={t('providerModel')}
                onChange={(event) => {
                  setLocalModel(event.target.value)
                  setManualProtocol(undefined)
                  setEffort('default')
                }}
              >
                {!selected && (
                  <option value="">
                    {t(catalog?.status === 'loading' ? 'providerLoading' : 'providerChooseModel')}
                  </option>
                )}
                {selected && !models.includes(selected) && (
                  <option value={selected}>{selected}</option>
                )}
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ))}
        {service === 'chat' && provider === 'opencode' && manual && !route && (
          <div className={styles.heading}>
            <span>{t('providerProtocol')}</span>
            <Select
              value={protocol}
              onChange={setManualProtocol}
              ariaLabel={t('providerProtocol')}
              options={[
                { value: 'chat-completions', label: 'Chat Completions' },
                { value: 'responses', label: 'Responses' },
                { value: 'messages', label: 'Messages' },
              ]}
            />
          </div>
        )}
        {service === 'chat' && provider !== 'deepseek' && (
          <div className={styles.heading}>
            <span>{t('settingsThinkingEffort')}</span>
            {efforts.length ? (
              <Select
                value={efforts.some((level) => level === effort) ? effort : 'default'}
                onChange={setEffort}
                ariaLabel={t('settingsThinkingEffort')}
                options={[
                  { value: 'default', label: t('providerDefaultEffort') },
                  ...efforts.map((value) => ({ value, label: value })),
                ]}
              />
            ) : (
              <span>{t('providerDefaultEffort')}</span>
            )}
          </div>
        )}
        {service === 'chat' && provider !== 'deepseek' && provider !== 'custom' && (
          <button className={styles.link} type="button" onClick={() => setManual(!manual)}>
            {t(manual ? 'providerChooseModel' : 'providerManualModel')}
          </button>
        )}
        <div className={styles.actions}>
          <Button type="submit" size="m">
            {t('providerApply')}
          </Button>
          <span role="status">{status && t(status)}</span>
        </div>
      </form>
    </details>
  )
}
