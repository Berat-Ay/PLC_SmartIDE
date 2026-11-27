import type { TabType } from '../stores/useUIStore'

/**
 * Single authoritative factory for editor tab IDs across ProjectTree, ProjectStore,
 * EditorWorkspace, and Cross-Reference navigation.
 */
export function makeTabId(type: TabType, targetId?: string): string {
  switch (type) {
    case 'hardware':
      return 'tab_hardware_config'
    case 'allTags':
      return 'tab_all_tags'
    case 'simulation':
      return 'tab_simulation'
    case 'trace':
      return 'tab_trace'
    case 'tagTable':
      return `tab_tags_${targetId || ''}`
    case 'db':
      return `tab_db_${targetId || ''}`
    case 'udt':
      return `tab_udt_${targetId || ''}`
    case 'lad':
      return `tab_lad_${targetId || ''}`
    case 'scl':
      return `tab_scl_${targetId || ''}`
  }
}
