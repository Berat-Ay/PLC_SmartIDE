import { ElectronApi } from '../shared/types/ipc'

declare global {
  interface Window {
    electronApi: ElectronApi
  }
}
