import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectPreferredUiLanguage,
  getActiveUiText,
  getUiText,
  isUiLanguage,
  setActiveUiLanguage,
  UI_LANGUAGE_SETTING_KEY
} from '../src/renderer/src/i18n.ts'

test('i18n language guards and setting key are stable', () => {
  assert.equal(UI_LANGUAGE_SETTING_KEY, 'ui.language')
  assert.equal(isUiLanguage('zh-CN'), true)
  assert.equal(isUiLanguage('en-US'), true)
  assert.equal(isUiLanguage('ja-JP'), false)
  assert.equal(isUiLanguage(null), false)
})

test('detectPreferredUiLanguage follows navigator language prefix', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'zh-TW' },
      configurable: true
    })
    assert.equal(detectPreferredUiLanguage(), 'zh-CN')

    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US' },
      configurable: true
    })
    assert.equal(detectPreferredUiLanguage(), 'en-US')
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'navigator', descriptor)
    } else {
      // @ts-expect-error cleanup dynamic global field for test isolation
      delete globalThis.navigator
    }
  }
})

test('getUiText caches by language and active language switches text bundle', () => {
  const zh1 = getUiText('zh-CN')
  const zh2 = getUiText('zh-CN')
  const en1 = getUiText('en-US')

  assert.equal(zh1 === zh2, true)
  assert.equal(zh1 === en1, false)

  setActiveUiLanguage('zh-CN')
  const activeZh = getActiveUiText()
  assert.equal(activeZh.language, 'zh-CN')
  assert.equal(activeZh.common.save, '保存')

  setActiveUiLanguage('en-US')
  const activeEn = getActiveUiText()
  assert.equal(activeEn.language, 'en-US')
  assert.equal(activeEn.common.save, 'Save')
})

test('i18n dynamic labels produce expected localized output', () => {
  const zh = getUiText('zh-CN')
  const en = getUiText('en-US')

  assert.equal(zh.currentKey(true), '当前密钥：已配置')
  assert.equal(en.currentKey(false), 'Current key: missing')
  assert.equal(zh.pluginStatusLabel('loading'), '加载中')
  assert.equal(zh.pluginStatusLabel('running'), '运行中')
  assert.equal(en.pluginStatusLabel('disabled'), 'Disabled')
  assert.equal(zh.boardGroupedBy(null), '按父级桶分组')
  assert.equal(en.boardGroupedBy('Status'), 'Grouped by Status')
})
