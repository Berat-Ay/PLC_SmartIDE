import React from 'react'
import { AlertTriangle, RotateCcw, ClipboardCopy, Check } from 'lucide-react'
import { BlackBoxLogger } from '../../services/diagnostics/BlackBoxLogger'

interface ErrorBoundaryProps {
  label: string
  onReset?: () => void
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  copied: boolean
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    error: null,
    copied: false
  }

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack)
    BlackBoxLogger.getInstance().log('UI_ACTION', `UI render error in ${this.props.label}: ${error.message}`, {
      label: this.props.label,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack
    })
  }

  private handleReload = (): void => {
    this.setState({ error: null, copied: false })
    this.props.onReset?.()
  }

  private handleCopyDump = (): void => {
    const dump = BlackBoxLogger.getInstance().exportDiagnosticReport()
    navigator.clipboard
      ?.writeText(dump)
      .then(() => {
        this.setState({ copied: true })
        setTimeout(() => this.setState({ copied: false }), 2000)
      })
      .catch(() => {})
  }

  public render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div
        data-testid="error-boundary-fallback"
        className="h-full w-full min-h-[200px] flex items-center justify-center bg-[#0b0d10] text-industrial-100 p-6 select-text"
      >
        <div className="max-w-lg w-full bg-[#111318] border border-rose-700/70 p-5 space-y-4 shadow-2xl">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-xs font-mono uppercase tracking-wider text-rose-300 font-bold">
                View Recovery — {this.props.label}
              </div>
              <p className="text-xs text-industrial-200 mt-1 break-words">
                {this.state.error.message || 'An unexpected rendering error occurred.'}
              </p>
            </div>
          </div>

          {this.state.error.stack && (
            <details className="text-[11px] font-mono text-industrial-400 bg-[#0a0c10] border border-[#27272a] p-2">
              <summary className="cursor-pointer text-industrial-300">Stack trace</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {this.state.error.stack}
              </pre>
            </details>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              data-testid="btn-error-boundary-reload"
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reload View</span>
            </button>
            <button
              type="button"
              data-testid="btn-error-boundary-copy"
              onClick={this.handleCopyDump}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1b1f26] hover:bg-[#252a34] border border-[#2e3440] text-industrial-200 text-xs font-semibold transition-colors"
            >
              {this.state.copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
              <span>{this.state.copied ? 'Diagnostic Copied' : 'Copy Diagnostic Dump'}</span>
            </button>
          </div>
        </div>
      </div>
    )
  }
}
