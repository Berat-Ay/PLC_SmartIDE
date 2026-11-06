import React, { useState } from 'react'
import { X, BookOpen, Trash2, CheckCircle, Upload, PlusCircle } from 'lucide-react'
import { RagKnowledgeEngine, StandardLibraryItem } from '../../services/ai/RagKnowledgeEngine'

interface PlcBookTrainerModalProps {
  isOpen: boolean
  onClose: () => void
}

export const PlcBookTrainerModal: React.FC<PlcBookTrainerModalProps> = ({ isOpen, onClose }) => {
  const ragEngine = RagKnowledgeEngine.getInstance()
  const [standards, setStandards] = useState<StandardLibraryItem[]>(ragEngine.getStandards())
  const [inputText, setInputText] = useState('')
  const [ruleName, setRuleName] = useState('')
  const [category, setCategory] = useState<'motor' | 'analog' | 'sequencing' | 'safety' | 'communication'>('motor')
  const [notification, setNotification] = useState<string | null>(null)

  if (!isOpen) return null

  const handleExtractAndSave = () => {
    const trimmed = inputText.trim()
    if (!trimmed) {
      setNotification('Write or paste a note first.')
      return
    }

    // Derive rule name if not manually specified
    const derivedName =
      ruleName.trim() ||
      `Note_${category.toUpperCase()}_${Date.now().toString().slice(-4)}`

    const newItem = ragEngine.saveStandardBlock({
      name: derivedName,
      category,
      description: trimmed,
      blockType: 'LAD',
      contentJson: ''
    })

    setStandards(ragEngine.getStandards())
    setInputText('')
    setRuleName('')
    setNotification(`Saved "${newItem.name}". The agent reads it when a request matches.`)
  }

  const handleDeleteRule = (id: string) => {
    ragEngine.removeStandard(id)
    setStandards(ragEngine.getStandards())
    setNotification('Note removed.')
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      if (content) {
        setInputText(content)
        setNotification(`Loaded ${file.name} (${content.length} characters).`)
      }
    }
    reader.readAsText(file)
  }

  return (
    <div
      data-testid="rag-book-trainer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs select-none p-4"
    >
      <div className="bg-[#0f1115] border border-[#27272a] rounded-none shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-11 px-4 bg-[#14161b] border-b border-[#27272a] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 bg-amber-600 flex items-center justify-center text-white">
              <BookOpen className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="font-mono font-bold text-industrial-100 text-xs tracking-wider uppercase">
                Circuit Patterns & Your Notes
              </span>
              <span className="text-[10px] text-industrial-400 block font-mono">
                Patterns are tested on this simulator only. Your notes are not tested.
              </span>
            </div>
          </div>
          <button
            data-testid="btn-close-book-trainer"
            onClick={onClose}
            className="text-industrial-400 hover:text-white p-1 hover:bg-[#1f2228] transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Notification Banner */}
        {notification && (
          <div className="px-4 py-1.5 bg-[#14231b] border-b border-[#10b981]/30 flex items-center justify-between">
            <span className="text-[11px] font-mono text-[#10b981] flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" />
              {notification}
            </span>
            <button
              onClick={() => setNotification(null)}
              className="text-[10px] font-mono text-industrial-400 hover:text-white"
            >
              [Dismiss]
            </button>
          </div>
        )}

        {/* Content Body */}
        <div className="p-4 overflow-y-auto space-y-4 flex-1">
          {/* Section 1: The user's notes */}
          <div className="p-3 bg-[#13151a] border border-[#27272a] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-amber-400 uppercase tracking-wide flex items-center gap-1.5">
                <PlusCircle className="w-3.5 h-3.5" />
                Add a Note
              </span>
              <label className="cursor-pointer text-[10px] font-mono text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                <Upload className="w-3 h-3" />
                Upload File (.txt, .md)
                <input
                  type="file"
                  accept=".txt,.md,.json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-mono text-industrial-400 block mb-1">
                  Name (Optional)
                </label>
                <input
                  data-testid="rag-rule-name-input"
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="e.g. Plant_Wiring_Rules"
                  className="w-full h-7 px-2 bg-[#0a0b0d] border border-[#27272a] focus:border-amber-500 text-industrial-100 font-mono text-xs outline-none rounded-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-industrial-400 block mb-1">
                  Category
                </label>
                <select
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value as 'motor' | 'analog' | 'sequencing' | 'safety' | 'communication')
                  }
                  className="w-full h-7 px-2 bg-[#0a0b0d] border border-[#27272a] focus:border-amber-500 text-industrial-100 font-mono text-xs outline-none rounded-none"
                >
                  <option value="motor">Motor & Drive Systems</option>
                  <option value="sequencing">Sequencing & Timers</option>
                  <option value="safety">Safety & Interlocks</option>
                  <option value="analog">Analog Scaling & PID</option>
                  <option value="communication">Communication</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-mono text-industrial-400 block mb-1">
                Note
              </label>
              <textarea
                data-testid="rag-book-input"
                rows={4}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="How your plant works: wiring conventions, naming rules, procedures. The agent gets this text as you write it, and only the first 1500 characters..."
                className="w-full p-2 bg-[#0a0b0d] border border-[#27272a] focus:border-amber-500 text-industrial-100 font-mono text-xs outline-none resize-none rounded-none"
              />
            </div>

            <div className="flex justify-end">
              <button
                data-testid="btn-extract-rag-rules"
                onClick={handleExtractAndSave}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-mono font-bold text-xs flex items-center gap-1.5 transition-colors rounded-none"
              >
                <BookOpen className="w-3.5 h-3.5" />
                Save Note
              </button>
            </div>
          </div>

          {/* Section 2: Patterns and notes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-industrial-300 uppercase tracking-wider">
                Patterns and Notes ({standards.length})
              </span>
            </div>

            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {standards.map((item) => (
                <div
                  key={item.id}
                  data-testid="rag-rule-item"
                  className="p-2.5 bg-[#111317] border border-[#27272a] hover:border-industrial-600 transition-colors flex items-start justify-between gap-3"
                >
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 bg-[#1f242d] text-amber-400 font-mono text-[9.5px] font-bold uppercase tracking-wider border border-amber-500/20">
                        {item.category}
                      </span>
                      <span className="font-mono font-bold text-industrial-100 text-xs break-all">
                        {item.name}
                      </span>
                      <span className="text-[9.5px] font-mono text-industrial-500 whitespace-nowrap">
                        {item.pattern ? 'tested on simulator' : 'your note'}
                      </span>
                    </div>
                    <p className="text-[11px] font-mono text-industrial-400 leading-snug line-clamp-3 break-words">
                      {item.description}
                    </p>
                  </div>
                  {!item.pattern && (
                    <button
                      data-testid="btn-delete-rule"
                      onClick={() => handleDeleteRule(item.id)}
                      className="text-industrial-500 hover:text-red-400 p-1 hover:bg-[#1a1c22] transition-colors"
                      title="Delete note"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="h-9 px-4 bg-[#14161b] border-t border-[#27272a] flex items-center justify-between">
          <span className="text-[10px] font-mono text-industrial-500">
            Entries that match a request are added to the prompt sent to the model.
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 bg-[#1e2229] hover:bg-[#282d37] text-industrial-200 font-mono text-xs transition-colors rounded-none"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

