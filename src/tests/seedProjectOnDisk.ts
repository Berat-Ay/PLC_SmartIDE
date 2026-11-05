import { FileEngine } from '../main/fileEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import * as path from 'path'
import * as fs from 'fs/promises'

async function run() {
  const root = process.cwd()
  console.log(`Seeding Everything-as-Code modular files into: ${root}`)

  const payload = DemoProjectSeeder.createDemoProject(root)
  await FileEngine.saveProject(payload)

  // Also create reserved simulation file
  const simPath = path.join(root, 'simulation', 'plant_scenario.sim.js')
  await fs.writeFile(
    simPath,
    `// ============================================================
// Phase 3 Reserved: Closed-Loop Plant Physics & Fault Injection
// Target: Chemical_Plant_Unit4
// ============================================================

export default function definePlantSimulation(runtime) {
  // Reserved for Phase 3 closed-loop physics rules
}
`,
    'utf-8'
  )

  console.log('✅ Project files successfully seeded on disk!')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
