import React, { useState } from 'react'
import { X, Download, Share2, FileCode, Check, Copy, ExternalLink, Terminal } from 'lucide-react'
import { TiaExportBridge, TiaExportBundle, ExportFileItem } from '../../services/export/TiaExportBridge'

interface TiaExportModalProps {
  isOpen: boolean
  onClose: () => void
}

export const TiaExportModal: React.FC<TiaExportModalProps> = ({ isOpen, onClose }) => {
  const [selectedFileIdx, setSelectedFileIdx] = useState(0)
  const [copiedFile, setCopiedFile] = useState(false)
  const [exportMode, setExportMode] = useState<'bundle' | 'openness'>('bundle')

  if (!isOpen) return null

  const bundle: TiaExportBundle = TiaExportBridge.generateBundle()
  const activeFile = bundle.files[selectedFileIdx] || bundle.files[0]

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content)
    setCopiedFile(true)
    setTimeout(() => setCopiedFile(false), 1200)
  }

  const handleDownloadFile = (file: ExportFileItem) => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDownloadAll = () => {
    for (const file of bundle.files) {
      handleDownloadFile(file)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs select-none">
      <div className="bg-industrial-900 border border-industrial-750 rounded-xl shadow-2xl w-[92vw] max-w-5xl h-[82vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-3.5 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-siemens-cyan/20 border border-siemens-cyan flex items-center justify-center text-siemens-cyan shadow-sm">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-industrial-100 flex items-center gap-2">
                <span>Export to Siemens TIA Portal</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
                  TIA Portal V17 / V18 / V19 Compatible
                </span>
              </h2>
              <p className="text-[11px] text-industrial-400">
                Generate Siemens SimaticML XML, SCL external sources, DBs, UDTs, tag CSVs, and Openness automation scripts.
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

        {/* Mode Selector & Summary Ribbon */}
        <div className="px-5 py-2.5 bg-industrial-950/80 border-b border-industrial-850 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExportMode('bundle')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                exportMode === 'bundle'
                  ? 'bg-siemens-cyan text-white shadow-xs'
                  : 'bg-industrial-900 text-industrial-400 hover:text-industrial-200 border border-industrial-800'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>External Source Bundle (.scl, .xml, .db, .csv)</span>
            </button>

            <button
              onClick={() => setExportMode('openness')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                exportMode === 'openness'
                  ? 'bg-purple-600 text-white shadow-xs'
                  : 'bg-industrial-900 text-industrial-400 hover:text-industrial-200 border border-industrial-800'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Openness C# Live Bridge</span>
            </button>
          </div>

          {/* Quick Metrics */}
          <div className="flex items-center gap-2 text-[11px] font-mono text-industrial-300">
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">
              {bundle.summary.totalTagsExported} Tags
            </span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">
              {bundle.summary.sclFilesCount} SCL Blocks
            </span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">
              {bundle.summary.simaticMlBlocksCount} LAD SimaticML
            </span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">
              {bundle.summary.dbFilesCount} DBs
            </span>
            <span className="bg-industrial-900 px-2 py-0.5 rounded border border-industrial-800">
              {bundle.summary.udtFilesCount} UDTs
            </span>
          </div>
        </div>

        {/* Content Body */}
        {exportMode === 'bundle' ? (
          <div className="flex-1 flex overflow-hidden">
            {/* Left File Tree / List */}
            <div className="w-64 bg-industrial-950/70 border-r border-industrial-800 flex flex-col overflow-y-auto">
              <div className="p-2.5 text-[10px] uppercase font-bold text-industrial-400 tracking-wider">
                Export Files ({bundle.files.length})
              </div>
              <div className="flex-1 p-2 space-y-1">
                {bundle.files.map((file, idx) => (
                  <button
                    key={file.filename}
                    onClick={() => setSelectedFileIdx(idx)}
                    className={`w-full text-left p-2 rounded-lg text-xs flex items-center gap-2 transition-colors ${
                      selectedFileIdx === idx
                        ? 'bg-industrial-800 text-cyan-300 border border-cyan-700/60 font-semibold'
                        : 'text-industrial-300 hover:bg-industrial-900 hover:text-white'
                    }`}
                  >
                    <FileCode className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    <div className="truncate flex-1">
                      <div className="truncate">{file.filename}</div>
                      <div className="text-[10px] text-industrial-500 font-mono">{file.folder}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Right File Content Preview */}
            <div className="flex-1 flex flex-col bg-industrial-900 overflow-hidden">
              <div className="px-4 py-2 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-industrial-100 font-bold">{activeFile.filename}</span>
                  <span className="text-industrial-500 text-[11px]">in /{activeFile.folder}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleCopy(activeFile.content)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs text-industrial-300 hover:text-white bg-industrial-800 hover:bg-industrial-700 rounded transition-colors"
                  >
                    {copiedFile ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedFile ? 'Copied!' : 'Copy Code'}</span>
                  </button>
                  <button
                    onClick={() => handleDownloadFile(activeFile)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs text-cyan-300 hover:text-white bg-cyan-950 border border-cyan-800 hover:bg-cyan-900 rounded transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    <span>Download File</span>
                  </button>
                </div>
              </div>

              <div className="flex-1 p-4 overflow-auto bg-industrial-950/60 font-mono text-xs leading-relaxed text-industrial-200 select-text">
                <pre>{activeFile.content}</pre>
              </div>
            </div>
          </div>
        ) : (
          /* Mode B: Openness CLI & Script Guide */
          <div className="flex-1 p-6 overflow-y-auto space-y-4 text-xs font-sans text-industrial-200">
            <div className="p-4 bg-purple-950/40 border border-purple-800/80 rounded-xl space-y-2">
              <div className="font-bold text-sm text-purple-200 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-purple-400" />
                <span>TIA Portal Openness Direct C# Bridge</span>
              </div>
              <p className="text-industrial-300 leading-relaxed">
                Antigravity generates a standalone <code className="text-purple-300">ImportToTiaPortal.cs</code> script
                utilizing the official <code className="text-purple-300">Siemens.Engineering.dll</code> library.
                Run this script on any Windows machine with Siemens TIA Portal installed to programmatically create the project,
                configure the CPU, and import all AST blocks, UDTs, and tag tables in seconds.
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-bold text-industrial-300 uppercase tracking-wider">
                Execution Instructions (Windows PowerShell):
              </div>
              <div className="bg-industrial-950 p-3 rounded-lg border border-industrial-800 font-mono text-[11px] text-cyan-300 select-text">
                # Compile and execute the Openness Bridge script with .NET 6/8 or Roslyn csi<br />
                dotnet new console -n TiaBridge<br />
                cp ImportToTiaPortal.cs TiaBridge/Program.cs<br />
                dotnet add TiaBridge reference "C:\Program Files\Siemens\Automation\Portal V18\PublicAPI\V18\Siemens.Engineering.dll"<br />
                dotnet run --project TiaBridge
              </div>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="px-5 py-3 bg-industrial-950 border-t border-industrial-800 flex items-center justify-between">
          <div className="text-xs text-industrial-400">
            Ready to import into SIMATIC STEP 7 Professional / TIA Portal V17-V19.
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-xs text-industrial-400 hover:text-white hover:bg-industrial-800 transition-colors"
            >
              Close
            </button>

            <button
              onClick={handleDownloadAll}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-siemens-cyan hover:bg-cyan-600 rounded-lg shadow-md transition-all active:scale-95"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download All ({bundle.files.length} Files)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

