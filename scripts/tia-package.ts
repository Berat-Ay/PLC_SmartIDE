// Prepares a folder to carry to a PC with TIA Portal: the exported project plus the bridge tool.
// Usage: npm run tia:package -- [projectDir] [outDir]
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { FileEngine } from '../src/main/fileEngine'
import { buildTiaBundle } from '../src/shared/tia/bundle'

async function main(): Promise<void> {
  const projectDir = path.resolve(process.argv[2] || 'examples/tia_smoke')
  const outDir = path.resolve(process.argv[3] || 'tia-package')
  const bundleDir = path.join(outDir, 'bundle')

  const payload = await FileEngine.loadProject(projectDir)
  if (payload.loadErrors?.length) {
    throw new Error(`The project has unreadable files: ${JSON.stringify(payload.loadErrors)}`)
  }

  const bundle = buildTiaBundle(payload)
  for (const file of bundle.files) {
    const target = path.join(bundleDir, file.folder, file.filename)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content, 'utf-8')
  }

  const toolDir = path.resolve('tools/tia-bridge')
  for (const name of ['TiaBridge.cs', 'build.cmd', 'run-verify.cmd', 'README.md']) {
    await fs.copyFile(path.join(toolDir, name), path.join(outDir, name))
  }

  try {
    execFileSync('cmd.exe', ['/c', path.join(toolDir, 'build.cmd'), path.join(outDir, 'TiaBridge.exe')], { stdio: 'inherit' })
  } catch {
    console.warn('The bridge was not built here. Run build.cmd on the TIA computer.')
  }

  console.log(`\nPackage ready: ${outDir}`)
  console.log(`Blocks and types: ${bundle.manifest.steps.length}, tag tables: ${bundle.manifest.tagTables.length}`)
  for (const warning of bundle.manifest.warnings) console.log(`Warning: ${warning}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
