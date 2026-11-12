import React, { useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import { useAppStore } from '../store/player'
import { useTranslation } from '../i18n'

export default function ResetLocalPasswordModal({ account, onClose, onSuccess }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async event => {
    event.preventDefault()
    if (busy) return
    if (password !== confirmation) { setError(t('Passwords do not match')); return }
    setBusy(true)
    setError('')
    try {
      const result = await api.resetLocalPassword({ userId: account.id, password })
      if (!result?.user || result.error) throw new Error(result?.error || 'Password reset failed')
      localStorage.setItem('lokal-user', JSON.stringify(result.user))
      useAppStore.getState().setUser(result.user)
      onSuccess()
    } catch (error) { setError(t(error.message)) }
    finally { setBusy(false) }
  }

  return <Modal open onClose={busy ? undefined : onClose} title={t('Reset Local Password')} width="max-w-sm">
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-white">@{account.username}</p>
      <p className="text-xs text-muted">{t('The old password cannot be displayed. Set a new one and sign in to this local account. Its history, likes and playlists are kept. This changes the password only on this device; export a new backup to carry it to another device.')}</p>
      <label className="block text-xs text-muted space-y-1">
        <span>{t('New password')}</span>
        <input autoFocus required autoComplete="new-password" disabled={busy} type={visible ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} className="w-full bg-card border border-border rounded-lg p-2 text-sm text-white" />
      </label>
      <label className="block text-xs text-muted space-y-1">
        <span>{t('Confirm password')}</span>
        <input required autoComplete="new-password" disabled={busy} type={visible ? 'text' : 'password'} value={confirmation} onChange={event => setConfirmation(event.target.value)} className="w-full bg-card border border-border rounded-lg p-2 text-sm text-white" />
      </label>
      <label className="flex gap-2 items-center text-xs text-muted"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />{t('Show password')}</label>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onClose} className="flex-1 py-2 bg-card border border-border rounded-lg text-sm text-muted">{t('Cancel')}</button>
        <button disabled={busy || !password.trim() || !confirmation} className="flex-1 py-2 bg-accent text-base rounded-lg text-sm disabled:opacity-50">{t(busy ? 'Saving...' : 'Reset and Sign In')}</button>
      </div>
    </form>
  </Modal>
}
