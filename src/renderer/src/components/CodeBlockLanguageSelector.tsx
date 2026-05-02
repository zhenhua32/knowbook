type CodeBlockLanguageSelectorProps = {
  currentLanguage: string | undefined
  onChange: (language: string) => void
  onBlur: () => void
  isZh: boolean
}

// 常见编程语言列表
const COMMON_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'java',
  'csharp',
  'cpp',
  'c',
  'go',
  'rust',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'sql',
  'html',
  'css',
  'scss',
  'bash',
  'shell',
  'json',
  'xml',
  'yaml',
  'markdown',
  'latex',
  'r',
  'perl',
  'lua',
  'vim',
  'dockerfile',
  'makefile'
]

export function CodeBlockLanguageSelector(props: CodeBlockLanguageSelectorProps) {
  const { currentLanguage, onChange, onBlur, isZh } = props

  return (
    <select
      className="code-block-language-selector"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      value={currentLanguage || ''}
      autoFocus
      title={isZh ? '选择编程语言' : 'Select programming language'}
    >
      <option value="">{isZh ? '无（自动检测）' : 'None (auto-detect)'}</option>
      {COMMON_LANGUAGES.map((lang) => (
        <option key={lang} value={lang}>
          {lang}
        </option>
      ))}
    </select>
  )
}
