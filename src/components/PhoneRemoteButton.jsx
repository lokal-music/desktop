import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { RefreshCw, Smartphone } from 'lucide-react'
import { api, peekSettings } from '../api'
import { useTranslation } from '../i18n'
import LinkedDevicesPanel from './LinkedDevicesPanel'

export default function PhoneRemoteButton() {
  const { t } = useTranslation()
  const root = useRef(null)
  const settingChangeSeq = useRef(0)
  const connectionRequestSeq = useRef(0)
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(() => peekSettings()?.phone_remote_enabled !== '0')
  const [saving, setSaving] = useState(false)
  const [settingError, setSettingError] = useState('')
  const [connectionInfo, setConnectionInfo] = useState(null)
  const [connectionLoading, setConnectionLoading] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [linkStatus, setLinkStatus] = useState('')

  useEffect(() => {
    if (!api.isElectron) return undefined
    let alive = true
    const version = settingChangeSeq.current
    Promise.resolve(api.getSettings()).then(settings => {
      if (alive && settings && settingChangeSeq.current === version) {
        setEnabled(settings.phone_remote_enabled !== '0')
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const refreshConnection = useCallback(async () => {
    const request = ++connectionRequestSeq.current
    setConnectionLoading(true)
    setConnectionError('')
    try {
      const info = await api.getRemoteConnectionInfo()
      if (request !== connectionRequestSeq.current) return
      setConnectionInfo(info || null)
      setConnectionError(info?.serverReachable === false
        ? (info.error || t('The remote server could not be reached.'))
        : '')
    } catch (error) {
      if (request === connectionRequestSeq.current) {
        setConnectionError(error?.message || t('The remote server could not be reached.'))
      }
    } finally {
      if (request === connectionRequestSeq.current) setConnectionLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!open || !enabled) {
      if (!enabled) {
        setConnectionInfo(null)
        setConnectionError('')
        setConnectionLoading(false)
      }
      return undefined
    }
    refreshConnection()
    return () => { connectionRequestSeq.current += 1 }
  }, [open, enabled, refreshConnection])

  useEffect(() => {
    if (!open) return undefined
    const outside = event => {
      if (!root.current?.contains(event.target)) setOpen(false)
    }
    const escape = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  const toggleEnabled = async () => {
    if (saving) return
    const next = !enabled
    const version = ++settingChangeSeq.current
    setSaving(true)
    setSettingError('')
    setLinkStatus('')
    try {
      const result = await api.saveSettings({ phone_remote_enabled: next ? '1' : '0' })
      if (result?.error) throw new Error(result.error)
      if (settingChangeSeq.current === version) setEnabled(next)
      window.dispatchEvent(new Event('lokal:settings-saved'))
    } catch (error) {
      if (settingChangeSeq.current === version) {
        setSettingError(error?.message || t("Couldn't save"))
      }
    } finally {
      if (settingChangeSeq.current === version) setSaving(false)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(connectionInfo.primary)
      setLinkStatus(t('Link copied'))
    } catch {
      setLinkStatus(t('Could not copy the link'))
    }
  }

  if (!api.isElectron) return null

  return (
    <div ref={root} className="relative flex-shrink-0" data-phone-remote-button>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        title={t('Phone Remote')}
        aria-label={t('Phone Remote')}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={"w-7 h-7 rounded-full flex items-center justify-center transition-colors bg-elevated hover:bg-card " + (enabled || open ? 'text-accent' : 'text-muted hover:text-text')}
      >
        <Smartphone size={15} strokeWidth={enabled ? 2.2 : 1.8} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={t('Phone Remote')}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full right-0 mt-2 w-80 max-w-[calc(100vw-1rem)] max-h-[min(70vh,520px)] overflow-y-auto rounded-xl border border-border bg-elevated p-3 shadow-2xl z-[70]"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-display uppercase tracking-wider text-muted">{t('Phone Remote')}</p>
              {enabled && (
                <button
                  type="button"
                  onClick={refreshConnection}
                  disabled={connectionLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted hover:bg-card hover:text-text disabled:opacity-40"
                >
                  <RefreshCw size={12} className={connectionLoading ? 'animate-spin' : ''} />
                  {connectionLoading ? t('Checking…') : t('Refresh')}
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t('Phone Remote')}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{t('Let a phone on the same Wi-Fi network control playback in Lokal.')}</p>
              </div>
              <button
                type="button"
                onClick={toggleEnabled}
                disabled={saving}
                aria-pressed={enabled}
                className={"flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-display uppercase tracking-wider transition-colors disabled:opacity-40 " + (enabled ? 'bg-accent/20 border-accent/50 text-accent' : 'border-border text-muted hover:text-white')}
              >
                {saving ? '…' : enabled ? t('On') : t('Off')}
              </button>
            </div>

            {settingError && <p role="alert" className="mt-2 text-xs text-red-400">{settingError}</p>}

            {enabled ? (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-text">{t('Connect a phone')}</p>
                {connectionInfo?.primary ? (
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <a
                          href={connectionInfo.primary}
                          onClick={event => { event.preventDefault(); api.openExternal(connectionInfo.primary) }}
                          className="block break-all text-sm text-accent underline underline-offset-2 hover:text-white"
                        >
                          {connectionInfo.primary.split('#')[0]}
                        </a>
                        <button
                          type="button"
                          onClick={copyLink}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted transition-colors hover:text-white"
                        >
                          {t('Copy link')}
                        </button>
                      </div>
                      {connectionInfo.qrUrl && (
                        <img src={connectionInfo.qrUrl} alt={t('Phone Remote QR code')} className="h-28 w-28 flex-shrink-0 rounded-lg bg-white p-1.5" />
                      )}
                    </div>
                    {connectionInfo.urls?.filter(url => url !== connectionInfo.primary).map(url => (
                      <a key={url} href={url} onClick={event => { event.preventDefault(); api.openExternal(url) }} className="block break-all text-xs text-muted underline underline-offset-2 hover:text-white">
                        {url.split('#')[0]}
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-muted">
                    {connectionLoading ? t('Checking…') : t('No LAN address was found. Connect this computer to Wi-Fi or Ethernet, then refresh.')}
                  </p>
                )}

                <p className="text-xs leading-relaxed text-muted">{t('Your phone and computer must be connected to the same Wi-Fi network.')}</p>
                <details className="text-xs leading-relaxed text-muted">
                  <summary className="cursor-pointer text-accent">{t('Phones show offline?')}</summary>
                  <div className="mt-2 space-y-2">
                    <p>{t('Open the current address above in your phone’s browser. If it cannot load, check that both devices use the same network and that guest Wi-Fi or a VPN is not isolating them.')}</p>
                    <p>{t('Try the address in this computer’s browser too. If it works here but not on the phone, check the firewall. On Windows, allow Lokal through Windows Defender Firewall on Private networks.')}</p>
                    <p>{t('Sign in to the account used when pairing. Each desktop has its own phone pairings; importing a backup does not move them. If this computer’s address changed, pair again using its current QR code.')}</p>
                  </div>
                </details>
                {enabled && <LinkedDevicesPanel />}
                {connectionInfo?.tokenRequired && <p className="text-xs leading-relaxed text-muted">{t('REMOTE_TOKEN is enabled. The phone remote will ask for the token when you connect; keep it private.')}</p>}
                {connectionError && (
                  <p className="text-xs leading-relaxed text-muted">
                    {connectionError}{connectionInfo?.platform === 'win32' ? ' ' + t('On Windows, allow Lokal or Electron through Windows Defender Firewall on Private networks, then refresh.') : ''}
                  </p>
                )}
                {linkStatus && <p className="text-xs text-muted">{linkStatus}</p>}
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
