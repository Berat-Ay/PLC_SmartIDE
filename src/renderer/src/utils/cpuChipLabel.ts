import type { CpuConfig } from '../../../shared/types/hardware'
import { getCpuProfile } from '../../../shared/constants/cpuProfiles'

/**
 * Formats the live Target CPU context chip shown in AgentPanel from the active
 * hardware configuration and project metadata (e.g. "CPU 1511-1 PN (S7-1500)").
 */
export function formatCpuChipLabel(
  hardwareConfig?: CpuConfig | null,
  targetCpu?: string | null
): string {
  const profile =
    getCpuProfile(hardwareConfig?.general?.cpuName) ||
    getCpuProfile(hardwareConfig?.general?.targetCpu) ||
    getCpuProfile(targetCpu || undefined)

  if (profile) {
    return `${profile.name} (${profile.family})`
  }

  const fallbackName = hardwareConfig?.general?.cpuName?.trim()
  if (fallbackName) return fallbackName

  const fallbackTarget = targetCpu?.trim()
  if (fallbackTarget) return fallbackTarget

  return 'Virtual S7'
}
