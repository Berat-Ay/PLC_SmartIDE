import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertCircle } from 'lucide-react'

export interface PromptModalProps {
  isOpen: boolean
  title: string
  label?: string
  description?: string
  initialValue: string
  placeholder?: string
  confirmLabel?: string
  validate?: (value: string) => string | null
  onConfirm: (value: string) => void
  onCancel: () => void
}

export const PromptModal: React.FC<PromptModalProps> = ({
  isOpen,
  title,
  label,
  description,
  initialValue,
  placeholder,
  confirmLabel = 'Confirm',
  validate,
  onConfirm,
  onCancel
}) => {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setValue(initialValue)
    setError(null)
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [isOpen, initialValue])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validate) {
      const validationError = validate(value)
      if (validationError) {
        setError(validationError)
        inputRef.current?.focus()
        return
      }
    }
    onConfirm(value)
  }

  return createPortal(
    <div
      data-testid="prompt-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div className="bg-[#111215] border border-[#27272a] shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#0c0d10] border-b border-[#27272a]">
          <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-industrial-100">{title}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="text-industrial-400 hover:text-white p-1 hover:bg-[#1c1f26] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          {description && <p className="text-[11px] text-industrial-400 font-sans">{description}</p>}

          <div>
            {label && (
              <label className="block text-[11px] font-mono text-industrial-300 mb-1.5">{label}</label>
            )}
            <input
              ref={inputRef}
              data-testid="prompt-modal-input"
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                if (error) setError(null)
              }}
              placeholder={placeholder}
              className="w-full h-8 px-2.5 bg-[#0c0d10] border border-[#27272a] focus:border-[#00a3a6] text-xs font-mono text-industrial-100 focus:outline-hidden"
            />
          </div>

          {error && (
            <div
              data-testid="prompt-modal-error"
              className="p-2 border border-red-700/80 bg-red-950/50 text-red-200 text-[11px] font-mono flex items-center gap-2"
            >
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#27272a]">
            <button
              type="button"
              data-testid="prompt-modal-cancel"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs font-mono text-industrial-300 hover:text-white hover:bg-[#1c1f26] border border-[#27272a] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="prompt-modal-confirm"
              className="px-4 py-1.5 text-xs font-mono font-bold text-white bg-[#00a3a6] hover:bg-[#008f91] border border-[#00c2c5] transition-colors cursor-pointer"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
