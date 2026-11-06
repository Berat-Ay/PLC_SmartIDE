import React, { useState } from 'react'
import { X, Sparkles, Key, Cpu, Globe, Check, RefreshCw, AlertTriangle } from 'lucide-react'
import { AiModelRouter, AiConfig, AiProvider } from '../../services/ai/AiModelRouter'

interface AiSettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({ isOpen, onClose }) => {
  const router = AiModelRouter.getInstance()
  const [config, setConfig] = useState<AiConfig>(router.getConfig())
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [discoveryStatus, setDiscoveryStatus] = useState(config.lastDiscoveryStatus)

  if (!isOpen) return null

  const handleVerifyAndFetchModels = async () => {
    setIsVerifying(true)
    try {
      if (config.provider === 'ollama') {
        await router.fetchOllamaModels(config.ollamaEndpoint)
      } else {
        const key = config.provider === 'gemini' ? config.geminiApiKey : config.openaiApiKey
        if (!key.trim()) {
          setDiscoveryStatus({
            success: false,
            message: 'API Key cannot be empty',
            timestamp: Date.now()
          })
          return
        }
        await router.fetchActiveModels(key, config.provider)
      }
      const updatedConfig = router.getConfig()
      setConfig(updatedConfig)
      setDiscoveryStatus(updatedConfig.lastDiscoveryStatus)
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

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    router.updateConfig(config)
    setSavedSuccess(true)
    setTimeout(() => {
      setSavedSuccess(false)
      onClose()
    }, 600)
  }

  return (
    <div data-testid="ai-settings-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs select-none">
      <div className="bg-industrial-900 border border-industrial-750 rounded-none shadow-2xl w-full max-w-lg overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-3.5 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
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
        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs font-sans">
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
                  value={config.selectedModelId}
                  onChange={(e) => setConfig({ ...config, selectedModelId: e.target.value, fastModel: e.target.value })}
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 font-mono text-xs focus:border-amber-500 focus:outline-hidden"
                >
                  {config.availableModels.map((m) => (
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
                <label className="block text-industrial-300 font-semibold mb-1 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>Google AI Studio Gemini API Key</span>
                </label>
                <div className="flex gap-2">
                  <input
                    data-testid="ai-api-key-input"
                    type="password"
                    value={config.geminiApiKey}
                    onChange={(e) => setConfig({ ...config, geminiApiKey: e.target.value })}
                    placeholder="AIzaSy..."
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
                <label className="block text-industrial-300 font-semibold mb-1 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>OpenAI API Key</span>
                </label>
                <input
                  type="password"
                  value={config.openaiApiKey}
                  onChange={(e) => setConfig({ ...config, openaiApiKey: e.target.value })}
                  placeholder="sk-..."
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-3 py-1.5 text-industrial-100 placeholder-industrial-600 focus:border-indigo-500 focus:outline-hidden font-mono"
                />
              </div>
              <div>
                <label className="block text-industrial-400 text-[11px] mb-1">API Base URL</label>
                <input
                  type="text"
                  value={config.openaiEndpoint}
                  onChange={(e) => setConfig({ ...config, openaiEndpoint: e.target.value })}
                  className="w-full bg-industrial-950 border border-industrial-700 rounded-none px-2.5 py-1 text-industrial-200 font-mono text-[11px]"
                />
              </div>
            </div>
          )}

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
              The agent needs an API key or a running Ollama server.
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

