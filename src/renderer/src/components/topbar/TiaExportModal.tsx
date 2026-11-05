import React, { useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, Download, FileCode, FolderOpen, Share2, Terminal, Upload, X } from 'lucide-react'
import { TiaExportBridge } from '../../services/export/TiaExportBridge'
import { TiaMergeResult } from '@shared/tia/merge'

interface TiaExportModalProps {
  isOpen: boolean
  onClose: () => void
}

type ModalTab = 'export' | 'verify' | 'import'

const TAB_LABELS: Record<ModalTab, string> = {
  export: 'Export files',
  verify: 'Compile in TIA',
  import: 'Import from TIA'
}

const TabIcon: React.FC<{ tab: ModalTab }> = ({ tab }) => {
  if (tab === 'export') return <FileCode className="w-3.5 h-3.5" />
  if (tab === 'verify') return <Terminal className="w-3.5 h-3.5" />
  return <Upload className="w-3.5 h-3.5" />
}

const NameList: React.FC<{ title: string; items: string[]; tone: string }> = ({ title, items, tone }) =>
  items.length === 0 ? null : (
    <div>
      <div className={`font-bold mb-1 ${tone}`}>
        {title} ({items.length})
      </div>
      <ul className="space-y-0.5 font-mono text-[11px] text-industrial-300 select-text">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  )

const ExportModalBody: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const bundle = useMemo(() => TiaExportBridge.generateBundle(), [])
  const [tab, setTab] = useState<ModalTab>('export')
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const [exportedTo, setExportedTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ folder: string; merge: TiaMergeResult } | null>(null)
  const [imported, setImported] = useState(false)

  const activeFile = bundle.files[selected] || bundle.files[0]
  const hasDiskAccess = typeof window !== 'undefined' && !!window.electronApi

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(activeFile.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const handleExport = async (): Promise<void> => {
    setError(null)
    try {
      const folder = await window.electronApi.exportTiaBundle(
        bundle.manifest.project,
        bundle.files.map(({ filename, folder: sub, content }) => ({ filename, folder: sub, content }))
      )
      if (folder) setExportedTo(folder)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePickImport = async (): Promise<void> => {
    setError(null)
    setImported(false)
    try {
      const picked = await window.electronApi.pickTiaImportFolder()
      if (picked) setPreview({ folder: picked.folder, merge: TiaExportBridge.previewImport(picked.files) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleApplyImport = (): void => {
    if (!preview) return
    TiaExportBridge.applyImport(preview.merge)
    setPreview(null)
    setImported(true)
  }

  const changes = preview ? preview.merge.added.length + preview.merge.replaced.length : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs select-none">
      <div
        data-testid="tia-modal"
        className="bg-industrial-900 border border-industrial-750 rounded-xl shadow-2xl w-[92vw] max-w-5xl h-[82vh] flex flex-col overflow-hidden"
      >
        <div className="px-5 py-3.5 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-siemens-cyan/20 border border-siemens-cyan flex items-center justify-center text-siemens-cyan">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-industrial-100">TIA Portal</h2>
              <p className="text-[11px] text-industrial-400">
                {bundle.targetCpu}: SCL blocks, data blocks, UDTs and tag tables. LAD blocks are not exported yet.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-industrial-400 hover:text-white hover:bg-industrial-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-2.5 bg-industrial-950/80 border-b border-industrial-850 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {(Object.keys(TAB_LABELS) as ModalTab[]).map((key) => (
              <button
                key={key}
                data-testid={`tia-tab-${key}`}
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                  tab === key
                    ? 'bg-siemens-cyan text-white'
                    : 'bg-industrial-900 text-industrial-400 hover:text-industrial-200 border border-industrial-800'
                }`}
              >
                <TabIcon tab={key} />
                <span>{TAB_LABELS[key]}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11px] font-mono text-industrial-300">
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">{bundle.summary.totalTagsExported} Tags</span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">{bundle.summary.sclFilesCount} SCL</span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">{bundle.summary.dbFilesCount} DBs</span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">{bundle.summary.udtFilesCount} UDTs</span>
            {bundle.summary.skippedBlocksCount > 0 && (
              <span className="bg-amber-950 text-amber-300 px-2 py-0.5 rounded border border-amber-800">
                {bundle.summary.skippedBlocksCount} skipped
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="px-5 py-2 bg-red-950/60 border-b border-red-900 text-xs text-red-300 select-text" data-testid="tia-error">
            {error}
          </div>
        )}

        {tab === 'export' && (
          <div className="flex-1 flex overflow-hidden">
            <div className="w-64 bg-industrial-950/70 border-r border-industrial-800 overflow-y-auto p-2 space-y-1">
              {bundle.files.map((file, index) => (
                <button
                  key={`${file.folder}/${file.filename}`}
                  onClick={() => setSelected(index)}
                  className={`w-full text-left p-2 rounded-lg text-xs flex items-center gap-2 transition-colors ${
                    selected === index
                      ? 'bg-industrial-800 text-cyan-300 border border-cyan-700/60 font-semibold'
                      : 'text-industrial-300 hover:bg-industrial-900 hover:text-white'
                  }`}
                >
                  <FileCode className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <div className="truncate flex-1">
                    <div className="truncate">{file.filename}</div>
                    <div className="text-[10px] text-industrial-500 font-mono">{file.folder || '/'}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex-1 flex flex-col overflow-hidden">
              {bundle.manifest.warnings.length > 0 && (
                <div data-testid="tia-warnings" className="max-h-28 overflow-y-auto px-4 py-2 bg-amber-950/40 border-b border-amber-900 text-[11px] text-amber-200 space-y-0.5 select-text">
                  {bundle.manifest.warnings.map((warning, index) => (
                    <div key={index} className="flex gap-1.5">
                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="px-4 py-2 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between text-xs font-mono">
                <span className="text-industrial-100 font-bold">{activeFile.filename}</span>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs text-industrial-300 hover:text-white bg-industrial-800 hover:bg-industrial-700 rounded transition-colors"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <div className="flex-1 p-4 overflow-auto bg-industrial-950/60 font-mono text-xs leading-relaxed text-industrial-200 select-text">
                <pre>{activeFile.content}</pre>
              </div>
            </div>
          </div>
        )}

        {tab === 'verify' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-4 text-xs text-industrial-200 leading-relaxed select-text">
            <div className="p-4 bg-amber-950/40 border border-amber-800 rounded-xl text-amber-200">
              This path has not been run against a real TIA Portal yet. The first run may report API differences.
            </div>
            <p>
              The bridge creates a new TIA project, imports the exported files, compiles them and writes the result to
              <code className="text-cyan-300"> tia-report.json</code>. It does not touch existing projects.
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>On this computer, from the project folder: <code className="text-cyan-300">npm run tia:package -- &lt;project folder&gt;</code></li>
              <li>Copy the <code className="text-cyan-300">tia-package</code> folder to the computer with TIA Portal V17 or newer.</li>
              <li>Add your Windows account to the <code className="text-cyan-300">Siemens TIA Openness</code> group there.</li>
              <li>Run <code className="text-cyan-300">run-verify.cmd</code> and allow Openness access if TIA asks.</li>
              <li>Bring back the <code className="text-cyan-300">result</code> folder. Open it on the Import tab to bring the code back.</li>
            </ol>
            <p className="text-industrial-400">
              Without the bridge: in TIA, add the .udt, .db and .scl files under External source files in the order listed in
              manifest.json and choose Generate blocks from source. Tag tables imported by hand need the .xlsx format: open
              PLC_Tags.csv in Excel and save it as .xlsx.
            </p>
          </div>
        )}

        {tab === 'import' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-4 text-xs text-industrial-200 select-text">
            <p className="leading-relaxed">
              Choose a bridge result folder, or a folder with .scl, .db, .udt and tag table .xml files from TIA. You will see
              the changes before anything is applied. LAD and FBD blocks are reported, not imported.
            </p>
            <button
              data-testid="tia-pick-import"
              disabled={!hasDiskAccess}
              onClick={() => void handlePickImport()}
              className="flex items-center gap-1.5 px-4 py-1.5 font-semibold text-white bg-siemens-cyan hover:bg-cyan-600 disabled:opacity-40 rounded-lg transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Choose folder</span>
            </button>
            {imported && (
              <div data-testid="tia-import-done" className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800 text-emerald-300">
                Import applied. Save the project to keep it, then compile to check it.
              </div>
            )}
            {preview && (
              <div className="space-y-3 p-4 rounded-xl bg-industrial-950 border border-industrial-800" data-testid="tia-import-preview">
                <div className="font-mono text-[11px] text-industrial-400">{preview.folder}</div>
                <NameList title="New" items={preview.merge.added} tone="text-emerald-400" />
                <NameList title="Replaces what is in the project" items={preview.merge.replaced} tone="text-amber-400" />
                <NameList title="Skipped" items={preview.merge.skipped} tone="text-red-400" />
                <NameList title="Warnings" items={preview.merge.warnings} tone="text-amber-300" />
                <div className="flex items-center gap-2 pt-1">
                  <button
                    data-testid="tia-apply-import"
                    disabled={changes === 0}
                    onClick={handleApplyImport}
                    className="px-4 py-1.5 font-semibold text-white bg-siemens-cyan hover:bg-cyan-600 disabled:opacity-40 rounded-lg transition-colors"
                  >
                    Apply {changes} change(s)
                  </button>
                  <button onClick={() => setPreview(null)} className="px-4 py-1.5 text-industrial-400 hover:text-white rounded-lg transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="px-5 py-3 bg-industrial-950 border-t border-industrial-800 flex items-center justify-between">
          <div className="text-xs text-industrial-400 truncate pr-4 select-text" data-testid="tia-export-status">
            {exportedTo ? `Written to ${exportedTo}` : `${bundle.files.length} files. Not compiled by TIA until you run the bridge.`}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={onClose} className="px-4 py-1.5 rounded-lg text-xs text-industrial-400 hover:text-white hover:bg-industrial-800 transition-colors">
              Close
            </button>
            <button
              data-testid="tia-export-folder"
              disabled={!hasDiskAccess}
              onClick={() => void handleExport()}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-siemens-cyan hover:bg-cyan-600 disabled:opacity-40 rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export to folder</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// The body mounts on open, so each opening exports the project as it is at that moment.
export const TiaExportModal: React.FC<TiaExportModalProps> = ({ isOpen, onClose }) =>
  isOpen ? <ExportModalBody onClose={onClose} /> : null
