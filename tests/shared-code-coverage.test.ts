import assert from 'node:assert/strict'
import test from 'node:test'
import { detectCodeLanguage, normalizeCodeLanguage } from '../src/shared/code.ts'

test('normalizeCodeLanguage handles aliases, passthrough, and empty values', () => {
  assert.equal(normalizeCodeLanguage('TSX'), 'typescript')
  assert.equal(normalizeCodeLanguage(' shell '), 'bash')
  assert.equal(normalizeCodeLanguage('kotlin'), 'kotlin')
  assert.equal(normalizeCodeLanguage(''), null)
  assert.equal(normalizeCodeLanguage(undefined), null)
})

test('detectCodeLanguage returns null for empty content', () => {
  assert.equal(detectCodeLanguage('   '), null)
})

test('detectCodeLanguage parses valid json before heuristics', () => {
  assert.equal(detectCodeLanguage('{"ok":true,"count":1}'), 'json')
  assert.equal(detectCodeLanguage('[1,2,3]'), 'json')
})

test('detectCodeLanguage falls back to heuristics for invalid json-like snippets', () => {
  assert.equal(detectCodeLanguage('{ broken: true }\nconst answer = 1'), 'javascript')
})

test('detectCodeLanguage supports additional language heuristics', () => {
  assert.equal(detectCodeLanguage('#!/usr/bin/env bash\necho "hello"\nif [ -n "$X" ]; then\n  grep x file\nfi'), 'bash')
  assert.equal(detectCodeLanguage('using System;\nnamespace Demo;\npublic class App { }'), 'csharp')
  assert.equal(detectCodeLanguage('package com.knowbook;\nimport java.util.List;\npublic class App { }'), 'java')
  assert.equal(detectCodeLanguage('package main\nimport "fmt"\nfunc main() {\n  x := 1\n  fmt.Print(x)\n}'), 'go')
  assert.equal(detectCodeLanguage('fn main() {\n  let mut a = 1;\n  println!("{}", a);\n}'), 'rust')
  assert.equal(detectCodeLanguage('---\nname: knowbook\nfeatures:\n  - ai\n  - plugin'), 'yaml')
})

test('detectCodeLanguage prefers explicit language even when content matches another language', () => {
  assert.equal(detectCodeLanguage('def f(x):\n    return x', 'ts'), 'typescript')
})

test('detectCodeLanguage picks strongest signal when multiple regexes match', () => {
  const mixed = 'interface User { id: string }\nconst a = 1\nconsole.log(a)'
  assert.equal(detectCodeLanguage(mixed), 'typescript')
})
