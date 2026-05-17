import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(scriptPath, '..', '..')

const args = process.argv.slice(2)
const requireArtifacts = args.includes('--require-artifacts')
const tag = readArgumentValue('--tag') ?? readTagFromEnvironment()
const currentPlatform = normalizePlatform(readArgumentValue('--platform') ?? process.platform)

const packageJsonPath = join(repoRoot, 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : ''

const requiredFiles = [
  'electron-builder.yml',
  '.github/workflows/release.yml',
  'build/icon.png',
  '发布与签名说明.md',
  '首个正式发版流程.md'
]

const failures = []
const notes = []

if (!version) {
  failures.push('package.json 缺少有效的 version。')
} else {
  notes.push(`版本号: ${version}`)
}

for (const relativePath of requiredFiles) {
  if (!existsSync(join(repoRoot, relativePath))) {
    failures.push(`缺少发布必需文件: ${relativePath}`)
  }
}

if (tag) {
  const expectedTag = `v${version}`
  if (tag !== expectedTag) {
    failures.push(`tag 与 package.json version 不一致: 当前为 ${tag}，期望为 ${expectedTag}`)
  } else {
    notes.push(`tag 校验通过: ${tag}`)
  }
} else {
  notes.push('未检测到 tag，跳过 tag/version 一致性校验。')
}

if (requireArtifacts) {
  const artifactResult = validateReleaseArtifacts({ repoRoot, version, platform: currentPlatform })
  if (artifactResult.error) {
    failures.push(artifactResult.error)
  } else {
    notes.push(`构建物校验通过: ${artifactResult.match}`)
  }
}

if (failures.length > 0) {
  console.error('Release preflight failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Release preflight passed.')
for (const note of notes) {
  console.log(`- ${note}`)
}

function readArgumentValue(flagName) {
  const flagIndex = args.indexOf(flagName)
  if (flagIndex === -1) {
    return null
  }

  return args[flagIndex + 1] ?? null
}

function readTagFromEnvironment() {
  const refName = process.env.GITHUB_REF_NAME?.trim()
  if (refName) {
    return refName
  }

  const ref = process.env.GITHUB_REF?.trim()
  if (ref?.startsWith('refs/tags/')) {
    return ref.slice('refs/tags/'.length)
  }

  return null
}

function normalizePlatform(platform) {
  switch (platform) {
    case 'win32':
    case 'windows':
      return 'windows'
    case 'darwin':
    case 'macos':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return platform
  }
}

function validateReleaseArtifacts({ repoRoot, version, platform }) {
  const releaseRoot = join(repoRoot, 'release')
  if (!existsSync(releaseRoot)) {
    return { error: 'release 目录不存在，请先运行打包命令。' }
  }

  const names = readdirSync(releaseRoot).map((entry) => basename(entry))
  if (names.length === 0) {
    return { error: 'release 目录为空，请先运行打包命令。' }
  }

  const patternsByPlatform = {
    windows: [
      new RegExp(`^KnowBook-${escapeRegExp(version)}-win-[^.]+\\.`),
      /^win-unpacked$/
    ],
    macos: [
      new RegExp(`^KnowBook-${escapeRegExp(version)}-mac-[^.]+\\.`),
      /^mac(?:-[^/\\]+)?$/
    ],
    linux: [
      new RegExp(`^KnowBook-${escapeRegExp(version)}-linux-[^.]+\\.`),
      /^linux-unpacked$/
    ]
  }

  const patterns = patternsByPlatform[platform]
  if (!patterns) {
    return { error: `不支持的校验平台: ${platform}` }
  }

  const match = names.find((name) => patterns.some((pattern) => pattern.test(name)))
  if (!match) {
    return {
      error: `未找到 ${platform} 平台的 release 构建物。当前 release 目录内容: ${names.join(', ') || '(empty)'}`
    }
  }

  return { match }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}