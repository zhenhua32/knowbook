import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// Input is the unmodified page downloaded from https://github.github.com/gfm/.
// The source's arrow glyph represents a tab in both Markdown and HTML samples.
const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('Usage: node scripts/extract-gfm-spec.mjs <downloaded-gfm.html>')
const document = new JSDOM(readFileSync(sourcePath, 'utf8')).window.document
assert.equal(document.querySelector('.version')?.textContent, 'Version 0.29-gfm (2019-04-06)')
let section = ''
const examples = []
for (const element of document.querySelectorAll('h1,h2,h3,h4,div.example')) {
  if (element.matches('h1,h2,h3,h4')) {
    const heading = element.cloneNode(true)
    heading.querySelector('.number')?.remove()
    section = heading.textContent.trim()
  } else {
    examples.push({
      example: Number(element.id.slice(8)), section,
      markdown: element.querySelector('code.language-markdown').textContent.replaceAll('→', '\t'),
      html: element.querySelector('code.language-html').textContent.replaceAll('→', '\t')
    })
  }
}
assert.deepEqual(examples.map((e) => e.example), Array.from({ length: 677 }, (_, i) => i + 1))
writeFileSync(new URL('../tests/fixtures/markdown-spec/gfm-0.29.json', import.meta.url), JSON.stringify(examples, null, 2) + '\n')
console.log(`Extracted ${examples.length} GFM examples.`)
