import { mkdirSync, writeFileSync } from 'node:fs'
import { auditMarkdownExample, loadMarkdownPolicies, loadMarkdownSpec, markdownSpecNames } from '../tests/helpers/markdownSpec'

const policies = loadMarkdownPolicies()
const report = markdownSpecNames.map((spec) => {
  const examples = loadMarkdownSpec(spec).map((example) => auditMarkdownExample(example, policies[spec][example.example]))
  const counts = {
    total: examples.length,
    grammarMatch: examples.filter((e) => e.grammar === 'match').length,
    explicitPolicy: examples.filter((e) => e.grammar === 'policy').length,
    plain: examples.filter((e) => e.plain).length,
    backup: examples.filter((e) => e.backup).length,
    stable: examples.filter((e) => e.stable).length,
    failed: examples.filter((e) => e.failures.length).length
  }
  console.log(spec, counts)
  for (const e of examples.filter((e) => e.failures.length)) console.error(`  #${e.example}: ${e.failures.join(', ')}`)
  return { spec, cycles: 3, counts, examples }
})
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/markdown-spec-report.json', JSON.stringify(report, null, 2) + '\n')
if (report.some((r) => r.counts.failed > 0)) process.exitCode = 1
