// Checks the circuit in a black-box dump against a scenario's acceptance tests.
// Usage: npm run scenario -- <robot-cell | pick-place> <dump file>
import * as fs from 'fs'
import { DemoProjectSeeder } from '../src/renderer/src/services/DemoProjectSeeder'
import { evaluateScenario, formatReport, projectFromDump } from '../src/renderer/src/services/scenarios/ScenarioAcceptance'
import { SCENARIOS } from '../src/renderer/src/services/scenarios/scenarios'

const [scenarioId, dumpFile] = process.argv.slice(2)
const scenario = SCENARIOS.find((s) => s.id === scenarioId)
if (!scenario || !dumpFile) {
  console.error(`Kullanım: npm run scenario -- <${SCENARIOS.map((s) => s.id).join(' | ')}> <dump dosyası>`)
  process.exit(2)
}

if (!fs.existsSync(dumpFile)) {
  console.error(`Dosya yok: ${dumpFile}\nBash'te yolu düz eğik çizgiyle yazın: dumps/dump7.txt`)
  process.exit(2)
}
const dump = fs.readFileSync(dumpFile, 'utf-8')
if (/lines hidden/.test(dump) || !/## 2\. ACTIVE OB1_MAIN LADDER AST/.test(dump) || !/## 3\. S7 TAG TABLE/.test(dump)) {
  console.error(
    'Bu dosya tam bir dump değil: devre (bölüm 2) veya etiket tablosu (bölüm 3) eksik.' +
      (/lines hidden/.test(dump) ? '\nMetin bir terminalden kopyalanmış ve bir kısmı gizlenmiş ("lines hidden").' : '') +
      '\nUygulamada hata ayıklama penceresinden raporu kopyalayıp doğrudan Not Defteri\'ne yapıştırın.'
  )
  process.exit(2)
}
const project = projectFromDump(dump, DemoProjectSeeder.createDemoProject())
const elementCount = project.ladBlocks.reduce((n, b) => n + b.networks.reduce((m, nw) => m + (nw.nodes?.length ?? 0), 0), 0)
if (elementCount === 0) {
  console.error(
    'Bu dump\'ta devre yok: OB1 boş. Ölçülecek bir şey olmadığından puan verilmedi.\n' +
      'Ajanın son cevabı kendi simülasyon testinden geçemeyip geri alınmış olabilir (bölüm 5\'te "Agent reply undone").'
  )
  process.exit(2)
}
const results = evaluateScenario(scenario, project)
console.log(formatReport(scenario, results))
process.exit(results.some((r) => !r.passed && r.check.kind === 'spec') ? 1 : 0)
