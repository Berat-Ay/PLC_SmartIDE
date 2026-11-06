import React, { useState } from 'react'
import {
  Cpu,
  FilePlus,
  FolderOpen,
  Sparkles,
  Code,
  Layers,
  ArrowRight,
  HardDrive,
  Info,
  CheckCircle2,
  Sliders,
  Shield
} from 'lucide-react'
import { ALL_CPU_PROFILES, CpuProfile, CPU_1214C_PROFILE } from '@shared/constants/cpuProfiles'
import { useProjectStore } from '../../stores/useProjectStore'

export const ProjectStartupWizard: React.FC = () => {
  const { createNewProject, loadDemoProject } = useProjectStore()

  const [activeTab, setActiveTab] = useState<'create' | 'open'>('create')
  const [projectName, setProjectName] = useState('Project_01')
  const [projectPath, setProjectPath] = useState('C:/Projects/S7/Project_01')
  const [selectedCpuId, setSelectedCpuId] = useState<string>(CPU_1214C_PROFILE.id)
  const [selectedLanguage, setSelectedLanguage] = useState<'LAD' | 'SCL'>('LAD')

  const selectedProfile: CpuProfile =
    ALL_CPU_PROFILES.find((p) => p.id === selectedCpuId) || CPU_1214C_PROFILE

  const s7_1200_cpus = ALL_CPU_PROFILES.filter((p) => p.family === 'S7-1200')
  const s7_1500_cpus = ALL_CPU_PROFILES.filter((p) => p.family === 'S7-1500')

  const handleCreate = () => {
    createNewProject({
      name: projectName.trim() || 'Project_01',
      targetPath: projectPath.trim(),
      cpuProfileId: selectedCpuId,
      defaultLanguage: selectedLanguage
    })
  }

  const handleOpenExisting = async () => {
    if (window.electronApi) {
      const selected = await window.electronApi.selectProjectDirectory()
      if (selected) {
        const payload = await window.electronApi.openProject(selected)
        useProjectStore.getState().setProject(payload)
      }
    } else {
      loadDemoProject()
    }
  }

  return (
    <div
      data-testid="project-startup-wizard"
      className="h-screen w-screen flex bg-[#0c0d10] text-industrial-100 font-sans select-none overflow-hidden"
    >
      {/* Left Navigation Rail (220px) */}
      <aside className="w-[220px] h-full bg-[#111215] border-r border-[#27272a] flex flex-col justify-between shrink-0">
        <div>
          {/* Rail Header */}
          <div className="h-12 px-4 border-b border-[#27272a] flex items-center gap-2.5 bg-[#0e0f12]">
            <div className="w-6 h-6 bg-[#00a3a6] flex items-center justify-center text-white font-mono font-bold text-xs">
              S7
            </div>
            <div>
              <div className="text-xs font-bold font-mono tracking-wider text-industrial-100 uppercase">
                Rungline
              </div>
              <div className="text-[10px] text-industrial-400 font-sans">
                S7-1200 / S7-1500 IDE
              </div>
            </div>
          </div>

          {/* Navigation Links */}
          <div className="p-2 space-y-1">
            <button
              data-testid="wizard-nav-create"
              onClick={() => setActiveTab('create')}
              className={`w-full h-9 px-3 flex items-center gap-2 text-xs font-medium border text-left transition-colors ${
                activeTab === 'create'
                  ? 'bg-[#1e2229] border-[#00a3a6] text-white'
                  : 'bg-transparent border-transparent text-industrial-400 hover:text-industrial-200 hover:bg-[#181a1f]'
              }`}
            >
              <FilePlus className="w-3.5 h-3.5 text-[#00a3a6]" />
              <span>Create New Project</span>
            </button>

            <button
              data-testid="wizard-nav-open"
              onClick={handleOpenExisting}
              className="w-full h-9 px-3 flex items-center gap-2 text-xs font-medium border border-transparent text-industrial-400 hover:text-industrial-200 hover:bg-[#181a1f] text-left transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 text-industrial-300" />
              <span>Open Existing Project</span>
            </button>
          </div>
        </div>

        {/* Secondary Utility at bottom */}
        <div className="p-3 border-t border-[#27272a] bg-[#0e0f12]">
          <div className="text-[10px] uppercase font-mono text-industrial-400 mb-2 font-bold">
            Reference Automation
          </div>
          <button
            data-testid="wizard-load-demo-button"
            onClick={loadDemoProject}
            title="Load Pre-configured Industrial Chemical Plant Demo"
            className="w-full h-8 px-2 flex items-center justify-center gap-1.5 text-xs font-semibold bg-[#1a232f] hover:bg-[#223042] border border-[#2c3d52] text-[#38bdf8] transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Load Reference Demo</span>
          </button>
        </div>
      </aside>

      {/* Main Configuration Form */}
      <main className="flex-1 h-full overflow-y-auto flex flex-col bg-[#0f1115]">
        {/* Top Header Strip */}
        <div className="h-14 shrink-0 px-6 border-b border-[#27272a] bg-[#14161b] flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-bold font-mono tracking-wide text-industrial-100 uppercase">
              Start / Create New S7 Engineering Project
            </h1>
            <p className="text-[11px] text-industrial-400">
              Configure Target Hardware Architecture, Firmware Version & Default Organization Block Language
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2 text-xs font-mono text-cyan-400 bg-[#16202b] px-3 py-1 border border-[#1e3448]">
            <HardDrive className="w-3.5 h-3.5" />
            <span>Siemens S7 Architecture</span>
          </div>
        </div>

        {/* Configuration Body */}
        <div className="flex-1 p-6 space-y-6 max-w-5xl">
          {/* Section 1: Project Details */}
          <div className="border border-[#27272a] bg-[#14161b] p-4 space-y-4">
            <div className="text-xs font-mono font-bold uppercase text-[#00a3a6] tracking-wider flex items-center gap-1.5">
              <span>01. General Project Information</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-mono text-industrial-300 mb-1">
                  Project Name:
                </label>
                <input
                  data-testid="wizard-project-name"
                  type="text"
                  value={projectName}
                  onChange={(e) => {
                    const name = e.target.value
                    setProjectName(name)
                    setProjectPath(`C:/Projects/S7/${name.trim() || 'Project_01'}`)
                  }}
                  className="w-full h-8 px-3 bg-[#0c0d10] border border-[#27272a] text-xs font-mono text-industrial-100 focus:border-[#00a3a6] focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono text-industrial-300 mb-1">
                  Target Directory:
                </label>
                <input
                  data-testid="wizard-project-path"
                  type="text"
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  className="w-full h-8 px-3 bg-[#0c0d10] border border-[#27272a] text-xs font-mono text-industrial-300 focus:border-[#00a3a6] focus:outline-hidden"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Hardware Architecture Catalog */}
          <div className="border border-[#27272a] bg-[#14161b] p-4 space-y-4">
            <div className="text-xs font-mono font-bold uppercase text-[#00a3a6] tracking-wider flex items-center justify-between">
              <span>02. Select Target PLC Hardware Catalog</span>
              <span className="text-[10px] text-industrial-400 font-sans normal-case">
                Click a CPU model to inspect datasheet parameters
              </span>
            </div>

            <div className="grid grid-cols-12 gap-4">
              {/* Left Column: CPU Selection Cards */}
              <div className="col-span-7 space-y-3">
                {/* S7-1200 Category */}
                <div>
                  <div className="text-[11px] font-mono font-bold text-industrial-300 mb-1.5 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-cyan-500 inline-block" />
                    <span>SIMATIC S7-1200 Compact Controllers</span>
                  </div>
                  <div className="space-y-1.5">
                    {s7_1200_cpus.map((cpu) => {
                      const isSel = selectedCpuId === cpu.id
                      return (
                        <div
                          key={cpu.id}
                          data-testid={`wizard-cpu-${cpu.id}`}
                          onClick={() => setSelectedCpuId(cpu.id)}
                          className={`p-2.5 border cursor-pointer transition-colors flex items-center justify-between ${
                            isSel
                              ? 'bg-[#17232e] border-[#00a3a6] text-white shadow-xs'
                              : 'bg-[#0f1115] border-[#27272a] text-industrial-300 hover:border-[#3f3f46] hover:bg-[#14161c]'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <Cpu className={`w-4 h-4 ${isSel ? 'text-cyan-400' : 'text-industrial-500'}`} />
                            <div>
                              <div className="font-mono font-bold text-xs text-industrial-100">
                                {cpu.name}
                              </div>
                              <div className="font-mono text-[10px] text-industrial-400">
                                {cpu.orderNumber} | {cpu.workMemory} Work Mem
                              </div>
                            </div>
                          </div>
                          <div className="text-[10px] font-mono text-cyan-400 text-right">
                            <div>DI {cpu.defaultDiChannels.length} / DQ {cpu.defaultDqChannels.length}</div>
                            <div className="text-industrial-500">AI {cpu.defaultAiChannels.length} / AQ {cpu.defaultAqChannels.length}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* S7-1500 Category */}
                <div>
                  <div className="text-[11px] font-mono font-bold text-industrial-300 mb-1.5 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-blue-500 inline-block" />
                    <span>SIMATIC S7-1500 Modular Controllers</span>
                  </div>
                  <div className="space-y-1.5">
                    {s7_1500_cpus.map((cpu) => {
                      const isSel = selectedCpuId === cpu.id
                      return (
                        <div
                          key={cpu.id}
                          data-testid={`wizard-cpu-${cpu.id}`}
                          onClick={() => setSelectedCpuId(cpu.id)}
                          className={`p-2.5 border cursor-pointer transition-colors flex items-center justify-between ${
                            isSel
                              ? 'bg-[#17232e] border-[#00a3a6] text-white shadow-xs'
                              : 'bg-[#0f1115] border-[#27272a] text-industrial-300 hover:border-[#3f3f46] hover:bg-[#14161c]'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <Cpu className={`w-4 h-4 ${isSel ? 'text-blue-400' : 'text-industrial-500'}`} />
                            <div>
                              <div className="font-mono font-bold text-xs text-industrial-100">
                                {cpu.name}
                              </div>
                              <div className="font-mono text-[10px] text-industrial-400">
                                {cpu.orderNumber} | {cpu.workMemory} Work Mem
                              </div>
                            </div>
                          </div>
                          <div className="text-[10px] font-mono text-blue-400 text-right">
                            <div>DI {cpu.defaultDiChannels.length} / DQ {cpu.defaultDqChannels.length}</div>
                            <div className="text-industrial-500">AI {cpu.defaultAiChannels.length} / AQ {cpu.defaultAqChannels.length}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* Right Column: Hardware Datasheet Panel */}
              <div className="col-span-5 bg-[#0c0d10] border border-[#27272a] p-3 text-xs flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="border-b border-[#27272a] pb-2 flex items-center justify-between">
                    <div className="font-mono font-bold text-cyan-300 text-xs">
                      {selectedProfile.name}
                    </div>
                    <span className="text-[10px] font-mono bg-[#16202b] text-cyan-400 px-1.5 py-0.5 border border-[#1e3448]">
                      Firmware {selectedProfile.firmwareVersion}
                    </span>
                  </div>

                  <table className="w-full text-[11px] font-mono border-collapse">
                    <tbody>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Order Number:</td>
                        <td className="py-1 text-right text-industrial-200">{selectedProfile.orderNumber}</td>
                      </tr>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Work Memory:</td>
                        <td className="py-1 text-right text-emerald-400">{selectedProfile.workMemory}</td>
                      </tr>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Load Memory:</td>
                        <td className="py-1 text-right text-industrial-200">{selectedProfile.loadMemory}</td>
                      </tr>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Retentive Memory:</td>
                        <td className="py-1 text-right text-industrial-200">{selectedProfile.retentiveMemory}</td>
                      </tr>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Onboard DI:</td>
                        <td className="py-1 text-right text-cyan-400">
                          {selectedProfile.defaultDiChannels.length} Channels (%IB0..%IB{Math.ceil(selectedProfile.defaultDiChannels.length / 8) - 1})
                        </td>
                      </tr>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Onboard DQ:</td>
                        <td className="py-1 text-right text-cyan-400">
                          {selectedProfile.defaultDqChannels.length} Channels (%QB0..%QB{Math.ceil(selectedProfile.defaultDqChannels.length / 8) - 1})
                        </td>
                      </tr>
                      <tr className="border-b border-[#1c1f26]">
                        <td className="py-1 text-industrial-400">Onboard AI:</td>
                        <td className="py-1 text-right text-purple-400">
                          {selectedProfile.defaultAiChannels.length} Channels (%IW64..%IW{64 + selectedProfile.defaultAiChannels.length * 2 - 2})
                        </td>
                      </tr>
                      <tr>
                        <td className="py-1 text-industrial-400">Onboard AQ:</td>
                        <td className="py-1 text-right text-purple-400">
                          {selectedProfile.defaultAqChannels.length} Channels
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 p-2 bg-[#12161f] border border-[#1b2636] text-[10px] text-industrial-400 space-y-1">
                  <div className="flex items-center gap-1 text-cyan-300 font-bold">
                    <Shield className="w-3 h-3" />
                    <span>Hardware Overlap Guard Ready</span>
                  </div>
                  <div>Physical I/O addresses auto-mapped into S7 Memory Guard bit-matrix.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Default OB1 Language */}
          <div className="border border-[#27272a] bg-[#14161b] p-4 space-y-3">
            <div className="text-xs font-mono font-bold uppercase text-[#00a3a6] tracking-wider">
              <span>03. Select Default Main [OB1] Programming Language</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div
                data-testid="wizard-lang-lad"
                onClick={() => setSelectedLanguage('LAD')}
                className={`p-3 border cursor-pointer transition-colors flex items-center gap-3 ${
                  selectedLanguage === 'LAD'
                    ? 'bg-[#18232c] border-[#00a3a6] text-white shadow-xs'
                    : 'bg-[#0f1115] border-[#27272a] text-industrial-400 hover:border-[#3f3f46]'
                }`}
              >
                <div className={`p-2 border ${selectedLanguage === 'LAD' ? 'bg-[#00a3a6]/20 border-[#00a3a6] text-[#00a3a6]' : 'bg-[#14161c] border-[#27272a] text-industrial-500'}`}>
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-mono font-bold text-xs text-industrial-100">
                    LAD (Ladder Logic Diagram)
                  </div>
                  <div className="text-[11px] text-industrial-400">
                    Strict AST Grid, series & parallel power rails, interactive contacts & coils.
                  </div>
                </div>
              </div>

              <div
                data-testid="wizard-lang-scl"
                onClick={() => setSelectedLanguage('SCL')}
                className={`p-3 border cursor-pointer transition-colors flex items-center gap-3 ${
                  selectedLanguage === 'SCL'
                    ? 'bg-[#18232c] border-[#00a3a6] text-white shadow-xs'
                    : 'bg-[#0f1115] border-[#27272a] text-industrial-400 hover:border-[#3f3f46]'
                }`}
              >
                <div className={`p-2 border ${selectedLanguage === 'SCL' ? 'bg-[#00a3a6]/20 border-[#00a3a6] text-[#00a3a6]' : 'bg-[#14161c] border-[#27272a] text-industrial-500'}`}>
                  <Code className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-mono font-bold text-xs text-industrial-100">
                    SCL (Structured Control Language)
                  </div>
                  <div className="text-[11px] text-industrial-400">
                    IEC 61131-3 structured text, mathematical calculations, loops & complex control.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Action Row */}
          <div className="pt-2 flex items-center justify-between border-t border-[#27272a]">
            <div className="text-xs text-industrial-400 font-mono flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Project will initialize with 0 tags and clean empty Main [OB1].</span>
            </div>

            <button
              data-testid="wizard-create-project"
              onClick={handleCreate}
              className="h-10 px-6 bg-[#00a3a6] hover:bg-[#008f91] text-white font-mono font-bold text-xs flex items-center gap-2 border border-[#00c2c5] shadow-md transition-colors cursor-pointer"
            >
              <span>CREATE PROJECT & INITIALIZE WORKSPACE</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}

