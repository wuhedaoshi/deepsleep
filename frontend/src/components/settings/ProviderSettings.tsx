import { useState, type FormEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  normalizeConnection,
  providerBases,
  services,
  type Service,
} from '../../services/api/connections.js'
import { setConnection, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './ProviderSettings.module.css'

const labels: Record<Service, TranslationKey> = {
  chat: 'providerChat',
  search: 'providerSearch',
  fetch: 'providerFetch',
  asr: 'providerAsr',
  tts: 'providerTts',
}
const providerNames = {
  deepseek: 'DeepSeek',
  opencode: 'OpenCode Zen',
  siliconflow: 'SiliconFlow / 硅基流动',
  tavily: 'Tavily',
}

export const ProviderSettings = () => {
  const t = useTranslate()
  return (
    <section className={styles.group} aria-label={t('providerServices')}>
      <h3>{t('providerServices')}</h3>
      <p>{t('providerPrivacy')}</p>
      {services.map((service) => (
        <ProviderRow key={service} service={service} />
      ))}
    </section>
  )
}

const ProviderRow = ({ service }: { service: Service }) => {
  const t = useTranslate()
  const saved = useSettings((state) => state.connections[service])
  const [provider, setProvider] = useState(saved?.provider ?? 'deepseek')
  const [base, setBase] = useState(saved?.provider === 'custom' ? saved.base : '')
  const [key, setKey] = useState(saved?.key ?? '')
  const [model, setModel] = useState(saved?.model ?? '')
  const [status, setStatus] = useState<'saved' | 'invalid' | null>(null)
  const name = (id: string) =>
    providerNames[id as keyof typeof providerNames] ?? t('providerCustom')
  const preset = providerBases[provider as keyof typeof providerBases]
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = provider === 'deepseek' ? null : { provider, base, key, model }
    if (value && !normalizeConnection(service, value)) {
      setStatus('invalid')
      return
    }
    setConnection(service, value)
    if (!value) {
      setBase('')
      setKey('')
      setModel('')
    }
    setStatus('saved')
  }
  return (
    <details className={styles.row}>
      <summary>
        <span>{t(labels[service])}</span>
        <span className={styles.current}>{name(saved?.provider ?? 'deepseek')}</span>
      </summary>
      <form className={styles.form} onSubmit={submit}>
        <label>
          {t('providerSelect')}
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value)
              setKey('')
              setModel('')
              setStatus(null)
            }}
          >
            <option value="deepseek">DeepSeek</option>
            {service === 'chat' && (
              <>
                <option value="opencode">OpenCode Zen</option>
                <option value="siliconflow">SiliconFlow / 硅基流动</option>
              </>
            )}
            {(service === 'search' || service === 'fetch') && (
              <option value="tavily">Tavily</option>
            )}
            <option value="custom">{t('providerCustom')}</option>
          </select>
        </label>
        {provider !== 'deepseek' && (
          <>
            {provider !== 'tavily' && (
              <p>
                {t(service === 'chat' ? 'providerChatHint' : 'providerToolHint', { path: service })}
              </p>
            )}
            <label>
              {t('providerBase')}
              <input
                type="url"
                value={preset ?? base}
                readOnly={Boolean(preset)}
                placeholder="https://api.example.com/v1"
                required
                onChange={(event) => {
                  setBase(event.target.value)
                  setStatus(null)
                }}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            {service === 'chat' && (
              <label>
                {t('providerModel')}
                <input
                  value={model}
                  placeholder={provider === 'opencode' ? 'deepseek-v4-pro' : undefined}
                  required
                  onChange={(event) => {
                    setModel(event.target.value)
                    setStatus(null)
                  }}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
            )}
            <label>
              {t('providerKey')}
              <input
                type="password"
                value={key}
                autoComplete="off"
                required={provider !== 'custom'}
                onChange={(event) => {
                  setKey(event.target.value)
                  setStatus(null)
                }}
              />
            </label>
          </>
        )}
        <div className={styles.actions}>
          <Button type="submit">{t('providerSave')}</Button>
          <span role="status">
            {status && t(status === 'saved' ? 'providerSaved' : 'providerInvalid')}
          </span>
        </div>
      </form>
    </details>
  )
}
