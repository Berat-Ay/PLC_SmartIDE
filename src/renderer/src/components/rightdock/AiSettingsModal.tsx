import React, { useEffect, useRef, useState } from 'react'
import { X, Sparkles, Key, Cpu, Globe, Check, RefreshCw, AlertTriangle, ShieldCheck, Trash2 } from 'lucide-react'
import type { SecretStatus } from '@shared/types/ipc'
import { AiModelRouter, AiConfig } from '../../services/ai/AiModelRouter'

interface AiSettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({ isOpen, onClose }) => {
  const router = AiModelRouter.getInstance()
  const [config, setConfig] = useState<AiConfig>(router.getConfig())
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(router.getSecretStatus())
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('')
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState('')
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [discoveryStatus, setDiscoveryStatus] = useState(config.lastDiscoveryStatus)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const latest = router.getConfig()
    setConfig(latest)
    setSecretStatus(router.getSecretStatus())
    setDiscoveryStatus(latest.lastDiscoveryStatus)
    setGeminiKeyDraft('')
    setOpenaiKeyDraft('')
    setSavedSuccess(false)
    // Refresh from main process if available
    router
      .hydrateSecrets()
      .then(() => setSecretStatus(router.getSecretStatus()))
      .catch(() => {})
  }, [isOpen, router])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  if (!isOpen) return null

  const hasSavedGemini = secretStatus.geminiApiKey || Boolean(config.geminiApiKey?.trim())
  const hasSavedOpenAi = secretStatus.openaiApiKey || Boolean(config.openaiApiKey?.trim())

  const handleClearKey = async (provider: 'gemini' | 'openai') => {
    await router.setApiKey(provider, '')
    setSecretStatus(router.getSecretStatus())
    if (provider === 'gemini') setGeminiKeyDraft('')
    else setOpenaiKeyDraft('')
    setConfig((prev) => ({
      ...prev,
      ...(provider === 'gemini' ? { geminiApiKey: '' } : { openaiApiKey: '' })
    }))
  }

  const handleVerifyAndFetchModels = async () => {
    setIsVerifying(true)
    try {
      if (config.provider === 'ollama') {
        if (config.allowPrivateNetwork !== router.getConfig().allowPrivateNetwork) {
          router.updateConfig({ allowPrivateNetwork: config.allowPrivateNetwork })
        }
        await router.fetchOllamaModels(config.ollamaEndpoint)
      } else {
        const draft = config.provider === 'gemini' ? geminiKeyDraft : openaiKeyDraft
        const hasStored = config.provider === 'gemini' ? hasSavedGemini : hasSavedOpenAi
        if (!draft.trim() && !hasStored) {
          setDiscoveryStatus({
            success: false,
            message: 'API Key cannot be empty',
            timestamp: Date.now()
          })
          return
        }
        if (config.provider === 'openai' && config.allowPrivateNetwork !== router.getConfig().allowPrivateNetwork) {
          router.updateConfig({ allowPrivateNetwork: config.allowPrivateNetwork })
        }
        await router.fetchActiveModels(
          draft,
          config.provider,
          config.provider === 'openai' ? config.openaiEndpoint : undefined
        )
      }
      const updated = router.getConfig()
      // Merge only discovery outputs so unsaved form edits (language, timeout, testFirst) are preserved
      setConfig((prev) => ({
        ...prev,
        availableModels: updated.availableModels,
        selectedModelId: updated.selectedModelId,
        ollamaModels: updated.ollamaModels,
        ollamaModel: updated.ollamaModel,
        openaiModels: updated.openaiModels,
        openaiModel: updated.openaiModel,
        ollamaEndpoint: updated.ollamaEndpoint,
        openaiEndpoint: updated.openaiEndpoint,
        lastDiscoveryStatus: updated.lastDiscoveryStatus
      }))
      setSecretStatus(router.getSecretStatus())
      setDiscoveryStatus(updated.lastDiscoveryStatus)
      if (config.provider === 'gemini') setGeminiKeyDraft('')
      if (config.provider === 'openai') setOpenaiKeyDraft('')
    } catch (err: unknown) {
      setDiscoveryStatus({
        success: false,
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now()
      })
    } finally {
      setIsVerifying(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const { geminiApiKey: _g, openaiApiKey: _o, ...nonSecretConfig } = config
    router.updateConfig(nonSecretConfig)
    if (geminiKeyDraft.trim()) {
      await router.setApiKey('gemini', geminiKeyDraft)
      setGeminiKeyDraft('')
    }
    if (openaiKeyDraft.trim()) {
      await router.setApiKey('openai', openaiKeyDraft)
      setOpenaiKeyDraft('')
    }
    setSecretStatus(router.getSecretStatus())
    setSavedSuccess(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      setSavedSuccess(false)
      onClose()
    }, 600)
  }

  return (
    <div data-testid="ai-settings-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs select-none">
      <div className="bg-industrial-900 border border-industrial-750 rounded-none shadow-2xl w-full max-w-lg max-h-[92vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-3.5 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-none bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-md">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-industrial-100 flex items-center gap-2">
                <span>AI Engineering Agent Settings</span>
                <span className="text-[10px] font-mono font-normal text-purple-400 bg-purple-950/80 px-2 py-0.5 rounded-none border border-purple-800">
                  Dual-Tier Router
                </span>
              </h2>
              <p className="text-[11px] text-industrial-400">Configure AI providers and reasoning models</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-none text-industrial-400 hover:text-industrial-200 hover:bg-industrial-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs font-sans overflow-y-auto">
          {/* Provider Selector */}
          <div>
            <label className="block text-industrial-300 font-semibold mb-1.5 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>AI Engine Provider</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                data-testid="provider-btn-gemini"
                type="button"
                onClick={() => setConfig({ ...config, provider: 'gemini' })}
                className={`p-2 border rounded-none text-left transition-all ${
                  config.provider === 'gemini'
                    ? 'bg-cyan-950/60 border-cyan-500 text-cyan-200 shadow-sm'
                    : 'bg-industrial-950 border-industrial-800 text-industrial-400 hover:border-industrial-700'
                }`}
              >
                <div className="font-bold text-[10px]">Google Gemini</div>
                <div className="text-[9px] opacity-75">Cloud API</div>
              </button>

              <button
                data-testid="provider-btn-ollama"
                type="button"
                onClick={() => setConfig({ ...config, provider: 'ollama' })}
                className={`p-2 border rounded-none text-left transition-all ${
                  config.provider === 'ollama'
                    ? 'bg-amber-950/60 border-amber-500 text-amber-200 shadow-sm'
                    : 'bg-industrial-950 border-industrial-800 text-industrial-400 hover:border-industrial-700'
                }`}
              >
                <div className="font-bold text-[10px]">Local Ollama</div>
                <div className="text-[9px] opacity-75">Offline Factory</div>
              </button>

              <button
                data-testid="provider-btn-openai"
                type="button"
                onClick={() => setConfig({ ...config, provider: 'openai' })}
                className={`p-2 border rounded-none text-left transition-all ${
                  config.provider === 'openai'
                    ? 'bg-indigo-950/60 border-indigo-500 text-indigo-200 shadow-sm'
                    : 'bg-industrial-950 border-industrial-800 text-industrial-400 hover:border-industrial-700'
                }`}
              >
                <div className="font-bold text-[10px]">OpenAI / Custom</div>
                <div className="text-[9px] opacity-75">GPT-4o & Endpoints</div>
              </button>
            </div>
          </div>

          {/* Local Ollama Endpoint & Model Discovery */}
          {config.provider === 'ollama' && (
            <div className="space-y-3 pt-1">
              <div>
                <label className="block text-industrial-300 font-semibold mb-1 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-amber-400" />
                  <span>Ollama Local Service Endpoint</span>
                </label>
                <div className="flex gap-2">
                  <input
                    data-testid="ai-ollama-endpoint-input"
                    type="text"
                    value={config.ollamaEndpoint}
                    onChange={(e) => setConfig({ ...config, ollamaEndpoint: e.target.value })}
                    placeholder="http://localhost:11434"
                    className="flex-1 bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 placeholder-industrial-600 focus:border-amber-500 focus:outline-hidden font-mono text-xs"
                  />
                  <button
                    data-testid="btn-fetch-ollama-models"
                    type="button"
                    onClick={handleVerifyAndFetchModels}
                    disabled={isVerifying}
                    className="px-3 py-1.5 bg-amber-950 hover:bg-amber-900 border border-amber-700 text-amber-200 text-xs font-semibold rounded-none flex items-center gap-1.5 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                    <span>{isVerifying ? 'Connecting...' : 'Fetch Local Models'}</span>
                  </button>
                </div>
              </div>

              {discoveryStatus && (
                <div
                  data-testid={discoveryStatus.success ? 'model-discovery-success-badge' : 'model-discovery-error-badge'}
                  className={`p-2 border rounded-none font-mono text-[11px] flex items-center gap-2 ${
                    discoveryStatus.success
                      ? 'bg-emerald-950/70 border-emerald-600 text-emerald-300'
                      : 'bg-rose-950/70 border-rose-600 text-rose-300'
                  }`}
                >
                  {discoveryStatus.success ? (
                    <Check className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                  )}
                  <span className="truncate">{discoveryStatus.message}</span>
                </div>
              )}

              {/* Active Synthesis Model Selector */}
              <div>
                <label className="block text-industrial-300 font-semibold mb-1 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-amber-400" />
                  <span>Active Ollama Coding Model</span>
                </label>
                <select
                  data-testid="ai-model-select"
                  value={config.ollamaModel || 'qwen2.5-coder:7b'}
                  onChange={(e) => setConfig({ ...config, ollamaModel: e.target.value })}
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 font-mono text-xs focus:border-amber-500 focus:outline-hidden"
                >
                  {(config.ollamaModels && config.ollamaModels.length > 0
                    ? config.ollamaModels
                    : [{ id: config.ollamaModel || 'qwen2.5-coder:7b', displayName: config.ollamaModel || 'qwen2.5-coder:7b' }]
                  ).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.id} ({m.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-2 bg-amber-950/30 border border-amber-800/40 text-amber-200/90 text-[11px] font-mono leading-relaxed">
                Local Factory Mode: Prompts are synthesized offline by local coding models (e.g. qwen2.5-coder:7b, deepseek-coder:6.7b). Zero telemetry or cloud egress.
              </div>
            </div>
          )}

          {/* Gemini API Key & Model Discovery */}
          {config.provider === 'gemini' && (
            <div className="space-y-3 pt-1">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-industrial-300 font-semibold flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    <span>Google AI Studio Gemini API Key</span>
                  </label>
                  {hasSavedGemini && (
                    <div className="flex items-center gap-2">
                      <span
                        data-testid="gemini-key-saved-badge"
                        className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-300 bg-emerald-950/60 border border-emerald-700/70 px-1.5 py-0.5"
                      >
                        <ShieldCheck className="w-3 h-3" />
                        <span>{secretStatus.geminiApiKey ? 'Encrypted in OS keychain' : 'Session key active'}</span>
                      </span>
                      <button
                        data-testid="btn-clear-gemini-key"
                        type="button"
                        onClick={() => void handleClearKey('gemini')}
                        className="inline-flex items-center gap-1 text-[10px] font-mono text-rose-300 hover:text-rose-200 px-1.5 py-0.5 border border-rose-800/70 bg-rose-950/40"
                        title="Remove saved Gemini API key"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Clear</span>
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    data-testid="ai-api-key-input"
                    type="password"
                    value={geminiKeyDraft}
                    onChange={(e) => setGeminiKeyDraft(e.target.value)}
                    placeholder={hasSavedGemini ? 'Saved in OS keychain (enter new key to replace)' : 'AIzaSy...'}
                    className="flex-1 bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 placeholder-industrial-600 focus:border-cyan-500 focus:outline-hidden font-mono text-xs"
                  />
                  <button
                    data-testid="btn-verify-fetch-models"
                    type="button"
                    onClick={handleVerifyAndFetchModels}
                    disabled={isVerifying}
                    className="px-3 py-1.5 bg-cyan-950 hover:bg-cyan-900 border border-cyan-700 text-cyan-200 text-xs font-semibold rounded-none flex items-center gap-1.5 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                    <span>{isVerifying ? 'Verifying...' : 'Verify Key & Fetch Active Models'}</span>
                  </button>
                </div>
              </div>

              {discoveryStatus && (
                <div
                  data-testid={discoveryStatus.success ? 'model-discovery-success-badge' : 'model-discovery-error-badge'}
                  className={`p-2 border rounded-none font-mono text-[11px] flex items-center gap-2 ${
                    discoveryStatus.success
                      ? 'bg-emerald-950/70 border-emerald-600 text-emerald-300'
                      : 'bg-rose-950/70 border-rose-600 text-rose-300'
                  }`}
                >
                  {discoveryStatus.success ? (
                    <Check className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                  )}
                  <span className="truncate">{discoveryStatus.message}</span>
                </div>
              )}

              {/* Active Synthesis Model Selector */}
              <div>
                <label className="block text-industrial-300 font-semibold mb-1 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Active Synthesis Model</span>
                </label>
                <select
                  data-testid="ai-model-select"
                  value={config.selectedModelId}
                  onChange={(e) => setConfig({ ...config, selectedModelId: e.target.value, fastModel: e.target.value })}
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 font-mono text-xs focus:border-cyan-500 focus:outline-hidden"
                >
                  {config.availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.id} ({m.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-industrial-400 text-[11px] mb-1">Fast Tier Fallback</label>
                  <input
                    type="text"
                    value={config.fastModel}
                    onChange={(e) => setConfig({ ...config, fastModel: e.target.value })}
                    className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-2.5 py-1 text-industrial-200 font-mono text-[11px]"
                  />
                </div>
                <div>
                  <label className="block text-industrial-400 text-[11px] mb-1">Deep Pro Fallback</label>
                  <input
                    type="text"
                    value={config.deepModel}
                    onChange={(e) => setConfig({ ...config, deepModel: e.target.value })}
                    className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-2.5 py-1 text-industrial-200 font-mono text-[11px]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* OpenAI Endpoint & Key */}
          {config.provider === 'openai' && (
            <div className="space-y-3 pt-1">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-industrial-300 font-semibold flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    <span>API Key</span>
                  </label>
                  {hasSavedOpenAi && (
                    <div className="flex items-center gap-2">
                      <span
                        data-testid="openai-key-saved-badge"
                        className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-300 bg-emerald-950/60 border border-emerald-700/70 px-1.5 py-0.5"
                      >
                        <ShieldCheck className="w-3 h-3" />
                        <span>{secretStatus.openaiApiKey ? 'Encrypted in OS keychain' : 'Session key active'}</span>
                      </span>
                      <button
                        data-testid="btn-clear-openai-key"
                        type="button"
                        onClick={() => void handleClearKey('openai')}
                        className="inline-flex items-center gap-1 text-[10px] font-mono text-rose-300 hover:text-rose-200 px-1.5 py-0.5 border border-rose-800/70 bg-rose-950/40"
                        title="Remove saved OpenAI API key"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Clear</span>
                      </button>
                    </div>
                  )}
                </div>
                <input
                  data-testid="openai-api-key-input"
                  type="password"
                  value={openaiKeyDraft}
                  onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                  placeholder={hasSavedOpenAi ? 'Saved in OS keychain (enter new key to replace)' : 'sk-...'}
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 placeholder-industrial-600 focus:border-indigo-500 focus:outline-hidden font-mono"
                />
              </div>
              <div>
                <label className="block text-industrial-400 text-[11px] mb-1">
                  API Base URL (OpenAI compatible, ends with /v1)
                </label>
                <div className="flex gap-2">
                  <input
                    data-testid="openai-endpoint-input"
                    type="text"
                    value={config.openaiEndpoint}
                    onChange={(e) => setConfig({ ...config, openaiEndpoint: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                    className="flex-1 bg-industrial-950 border border-industrial-700 rounded-none px-2.5 py-1 text-industrial-200 font-mono text-[11px]"
                  />
                  <button
                    data-testid="btn-openai-fetch-models"
                    type="button"
                    onClick={handleVerifyAndFetchModels}
                    disabled={isVerifying}
                    className="px-3 py-1 bg-indigo-950 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 text-[11px] font-semibold rounded-none flex items-center gap-1.5 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                    <span>{isVerifying ? 'Checking...' : 'Check & Fetch Models'}</span>
                  </button>
                </div>
              </div>

              {discoveryStatus && (
                <div
                  data-testid={discoveryStatus.success ? 'openai-discovery-success-badge' : 'openai-discovery-error-badge'}
                  className={`p-2 border rounded-none font-mono text-[11px] flex items-center gap-2 ${
                    discoveryStatus.success
                      ? 'bg-emerald-950/70 border-emerald-600 text-emerald-300'
                      : 'bg-rose-950/70 border-rose-600 text-rose-300'
                  }`}
                >
                  {discoveryStatus.success ? (
                    <Check className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                  )}
                  <span className="truncate">{discoveryStatus.message}</span>
                </div>
              )}

              <div>
                <label className="block text-industrial-300 font-semibold mb-1 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Model</span>
                </label>
                {/* A list from the server, but any name can be typed */}
                <input
                  data-testid="openai-model-input"
                  type="text"
                  list="openai-model-options"
                  value={config.openaiModel}
                  onChange={(e) => setConfig({ ...config, openaiModel: e.target.value })}
                  placeholder="model name, e.g. gpt-4o"
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 placeholder-industrial-600 font-mono text-xs focus:border-indigo-500 focus:outline-hidden"
                />
                <datalist id="openai-model-options">
                  {(config.openaiModels || []).map((m) => (
                    <option key={m.id} value={m.id} />
                  ))}
                </datalist>
              </div>
            </div>
          )}

          {/* Private LAN opt-in for factory Ollama / OpenAI-compatible servers */}
          {(config.provider === 'ollama' || config.provider === 'openai') && (
            <div>
              <label className="flex items-center gap-2 text-industrial-300 font-semibold cursor-pointer">
                <input
                  data-testid="ai-allow-private-network-toggle"
                  type="checkbox"
                  checked={!!config.allowPrivateNetwork}
                  onChange={(e) => setConfig({ ...config, allowPrivateNetwork: e.target.checked })}
                />
                <span>Allow private LAN AI endpoints</span>
              </label>
              <p className="mt-1 text-industrial-500 text-[10px]">
                Loopback (localhost / 127.0.0.1) is always allowed. Enable this only when connecting to an Ollama or vLLM server on your private factory LAN (10.x / 172.16-31.x / 192.168.x).
              </p>
            </div>
          )}

          {/* How long one model request may take */}
          <div>
            <label className="block text-industrial-300 font-semibold mb-1.5">Request timeout (seconds)</label>
            <input
              data-testid="ai-timeout-input"
              type="number"
              min={10}
              max={600}
              value={config.requestTimeoutSec}
              onChange={(e) => setConfig({ ...config, requestTimeoutSec: Math.min(600, Math.max(10, Number(e.target.value) || 180)) })}
              className="w-28 bg-industrial-950 border border-industrial-700 rounded-none px-2.5 py-1 text-industrial-200 font-mono text-[11px]"
            />
            <span className="ml-2 text-industrial-500 text-[10px]">Long ladder answers can take minutes</span>
          </div>

          {/* Test first: the user approves the simulation test before the circuit is written */}
          <div>
            <label className="flex items-center gap-2 text-industrial-300 font-semibold cursor-pointer">
              <input
                data-testid="ai-test-first-toggle"
                type="checkbox"
                checked={!!config.testFirst}
                onChange={(e) => setConfig({ ...config, testFirst: e.target.checked })}
              />
              <span>Test first</span>
            </label>
            <p className="mt-1 text-industrial-500 text-[10px]">
              The agent first writes the simulation test from your request and shows it to you. The circuit is written only after you approve it, and the agent cannot change the approved test.
            </p>
          </div>

          {/* Built-in scenario acceptance tests: shown to the user, or also used as a gate for the model */}
          <div>
            <label className="block text-industrial-300 font-semibold mb-1.5">Scenario acceptance test</label>
            <select
              data-testid="ai-acceptance-gate-select"
              value={config.acceptanceGate || 'report'}
              onChange={(e) => setConfig({ ...config, acceptanceGate: e.target.value as AiConfig['acceptanceGate'] })}
              className="bg-industrial-950 border border-industrial-700 rounded-none px-2.5 py-1 text-industrial-200 font-mono text-[11px]"
            >
              <option value="report">Report (show to me only)</option>
              <option value="enforce">Enforce (send spec failures to the model)</option>
              <option value="off">Off</option>
            </select>
            <p className="mt-1 text-industrial-500 text-[10px]">
              Used only when your request is one of the built-in scenarios (robot cell, pick &amp; place, textbook exercises). Report shows how the circuit meets the scenario's specification and never tells the model. Enforce undoes a circuit that fails a spec check and sends the failures to the model, so a pass is no longer an impartial result.
            </p>
          </div>

          {/* Language Preference */}
          <div>
            <label className="block text-industrial-300 font-semibold mb-1.5 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-emerald-400" />
              <span>Language Preference</span>
            </label>
            <div className="flex items-center gap-2">
              {[
                { id: 'auto', label: 'Auto-Detect' },
                { id: 'en', label: 'English' },
                { id: 'tr', label: 'Türkçe' }
              ].map((lang) => (
                <button
                  key={lang.id}
                  type="button"
                  onClick={() => setConfig({ ...config, language: lang.id as AiConfig['language'] })}
                  className={`px-3 py-1.5 rounded-none border text-[11px] font-medium transition-colors ${
                    config.language === lang.id
                      ? 'bg-industrial-800 border-cyan-500 text-cyan-200'
                      : 'bg-industrial-950 border-industrial-800 text-industrial-400 hover:text-industrial-200'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-3 border-t border-industrial-800 flex items-center justify-between">
            <span className="text-[11px] text-industrial-500 italic">
              Keys stay in the OS encrypted store.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-none text-industrial-400 hover:text-white hover:bg-industrial-800 transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="ai-settings-save-button"
                type="submit"
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-none bg-siemens-cyan hover:bg-cyan-600 text-white font-semibold transition-colors shadow-sm"
              >
                {savedSuccess ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-white" />
                    <span>Saved!</span>
                  </>
                ) : (
                  <span>Save Configuration</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
