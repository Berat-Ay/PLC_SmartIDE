import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertTriangle, Info } from 'lucide-react'

export interface ConfirmModalProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
  alertOnly?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  alertOnly = false,
  onConfirm,
  onCancel
}) => {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const raf = requestAnimationFrame(() => {
      confirmBtnRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [isOpen])

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

  const isDanger = tone === 'danger'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      data-testid="confirm-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none"
    >
      <div className="bg-[#111215] border border-[#27272a] shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#0c0d10] border-b border-[#27272a]">
          <div className="flex items-center gap-2">
            {isDanger ? (
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            ) : (
              <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            )}
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-industrial-100">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-industrial-400 hover:text-white p-1 hover:bg-[#1c1f26] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p data-testid="confirm-modal-message" className="text-xs text-industrial-200 whitespace-pre-line font-sans">
            {message}
          </p>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#27272a]">
            {!alertOnly && (
              <button
                type="button"
                data-testid="confirm-modal-cancel"
                onClick={onCancel}
                className="px-3 py-1.5 text-xs font-mono text-industrial-300 hover:text-white hover:bg-[#1c1f26] border border-[#27272a] transition-colors cursor-pointer"
              >
                {cancelLabel}
              </button>
            )}
            <button
              ref={confirmBtnRef}
              type="button"
              data-testid="confirm-modal-confirm"
              onClick={onConfirm}
              className={`px-4 py-1.5 text-xs font-mono font-bold text-white border transition-colors cursor-pointer ${
                isDanger
                  ? 'bg-rose-700 hover:bg-rose-600 border-rose-500'
                  : 'bg-[#00a3a6] hover:bg-[#008f91] border-[#00c2c5]'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
