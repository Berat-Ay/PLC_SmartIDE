import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useTagStore } from './stores/useTagStore'
import { useBlockStore } from './stores/useBlockStore'
import { useRuntimeStore } from './stores/useRuntimeStore'
import { useHardwareStore } from './stores/useHardwareStore'
import { useUIStore } from './stores/useUIStore'
import { useProjectStore } from './stores/useProjectStore'
import { AiModelRouter } from './services/ai/AiModelRouter'
import { LadderDslCompiler } from './services/compiler/LadderDslCompiler'
import { LadderGridLayoutEngine } from './services/layout/LadderGridLayoutEngine'
import { DomVisualInspector } from './services/debug/DomVisualInspector'
import { S7BinaryMemory } from './runtime/S7BinaryMemory'
import { PlcRuntimeEngine } from './runtime/PlcRuntimeEngine'
import { StlListingGenerator } from './services/compiler/StlListingGenerator'
import { ProjectCompilerEngine } from './services/compiler/ProjectCompilerEngine'
import { RagKnowledgeEngine } from './services/ai/RagKnowledgeEngine'
import { CoilDiagnosticEngine } from './services/ai/CoilDiagnosticEngine'

if (typeof window !== 'undefined') {
  ;(window as unknown as { plcTestContext?: unknown }).plcTestContext = {
    useTagStore,
    useBlockStore,
    useRuntimeStore,
    useHardwareStore,
    useUIStore,
    useProjectStore,
    AiModelRouter,
    LadderDslCompiler,
    LadderGridLayoutEngine,
    DomVisualInspector,
    S7BinaryMemory,
    PlcRuntimeEngine,
    StlListingGenerator,
    ProjectCompilerEngine,
    RagKnowledgeEngine,
    CoilDiagnosticEngine
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
