import { useTranslation } from '../i18n'
import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff, User, Lock, Sparkles } from 'lucide-react'
import Modal from './Modal'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/player'
import { api } from '../api'

function Field({ label, type = 'text', value, onChange, placeholder, icon: Icon, rightSlot }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-display text-muted uppercase tracking-widest">{label}</label>
      <div className="relative">
        {Icon && <Icon size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />}
        <input
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full bg-card border border-border rounded-xl py-2.5 text-sm text-white placeholder-subtle outline-none focus:border-accent/60 transition-colors ${Icon ? 'pl-9' : 'pl-4'} ${rightSlot ? 'pr-10' : 'pr-4'}`}
        />
        {rightSlot && <div className="absolute right-3 top-1/2 -translate-y-1/2">{rightSlot}</div>}
      </div>
    </div>
  )
}

export default function AuthModal() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { showAuthModal, authMode, closeAuth, setUser, openAuth } = useAppStore()
  const [form, setForm] = useState({ username: '', displayName: '', password: '' })
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const set = (key) => (val) => setForm(f => ({ ...f, [key]: val }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      let result
      if (authMode === 'login') {
        result = await api.login({ username: form.username, password: form.password })
      } else {
        result = await api.register({ username: form.username, displayName: form.displayName, password: form.password })
      }
      if (result?.error) { setError(result.error); return }
      if (result?.user) {
        localStorage.setItem('lokal-user', JSON.stringify(result.user))
        setUser(result.user)
        closeAuth()
        setForm({ username: '', displayName: '', password: '' })
      }
    } finally {
      setLoading(false)
    }
  }

  const switchMode = () => {
    setError('')
    openAuth(authMode === 'login' ? 'register' : 'login')
  }

  return (
    <Modal open={showAuthModal} onClose={closeAuth} width="max-w-sm">
      <AnimatePresence mode="wait">
        <motion.form
          key={authMode}
          initial={{ opacity: 0, x: authMode === 'login' ? -20 : 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: authMode === 'login' ? 20 : -20 }}
          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          onSubmit={submit}
          className="space-y-4"
        >
          <div className="mb-6">
            <div className="w-10 h-10 bg-accent/15 rounded-xl flex items-center justify-center mb-3">
              {authMode === 'login' ? <User size={18} className="text-accent" /> : <Sparkles size={18} className="text-accent" />}
            </div>
            <h2 className="font-display text-lg text-white">
              {authMode === 'login' ? t('Welcome back') : t('Create account')}
            </h2>
            <p className="text-xs text-muted mt-1">{authMode === 'login' ? t('Sign in to your profile') : t('Set up your local profile')}</p>
          </div>

          <Field label={t("Username")} value={form.username} onChange={set('username')} placeholder={t("Username")} icon={User} />

          {authMode === 'register' && (
            <Field label={t("Display Name")} value={form.displayName} onChange={set('displayName')} placeholder={t("Your name")} />
          )}

          <Field
            label={t("Password")} type={showPass ? 'text' : 'password'}
            value={form.password} onChange={set('password')} placeholder={t("••••••••")} icon={Lock}
            rightSlot={
              <button type="button" onClick={() => setShowPass(v => !v)} className="text-muted hover:text-white transition-colors">
                {showPass ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            }
          />

          {error && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </motion.p>
          )}

          {authMode === 'login' && api.isElectron && <button type="button" onClick={() => {
            closeAuth()
            navigate('/settings', { state: { category: 'data' } })
          }} className="text-xs text-accent hover:text-accent-dim">{t('Forgot password? Reset your local account in Settings → Data → Accounts.')}</button>}

          <button
            type="submit"
            disabled={loading || !form.username || !form.password}
            className="w-full py-2.5 bg-accent text-base rounded-xl text-sm font-medium hover:bg-accent-dim transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-2"
          >
            {loading ? 'Please wait…' : authMode === 'login' ? 'Sign In' : 'Create Account'}
          </button>

          <p className="text-xs text-center text-muted pt-1">
            {authMode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button type="button" onClick={switchMode} className="text-accent hover:text-accent-dim transition-colors">
              {authMode === 'login' ? 'Create one' : 'Sign in'}
            </button>
            .<br />
            <span className="text-muted/70">{t("Your account is stored locally and not sent anywhere.")}</span>
          </p>
          
        </motion.form>
      </AnimatePresence>
    </Modal>
  )
}
