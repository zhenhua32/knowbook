/**
 * @typedef {Object} ThemeColors
 * @property {string} background
 * @property {string} surface
 * @property {string} surfaceRaised
 * @property {string} sidebar
 * @property {string} sidebarRaised
 * @property {string} sidebarText
 * @property {string} sidebarMuted
 * @property {string} text
 * @property {string} textSoft
 * @property {string} textMuted
 * @property {string} line
 * @property {string} lineStrong
 * @property {string} accent
 * @property {string} accentStrong
 * @property {string} accentSoft
 * @property {string} danger
 * @property {string} success
 */

/**
 * @typedef {Object} Theme
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'light' | 'dark'} mode
 * @property {ThemeColors} colors
 */

/** @type {Theme[]} */
const themes = [
  {
    id: 'cloud', name: '云白', description: '清透纸面与蓝色点缀，适合日常整理。', mode: 'light',
    colors: {
      background: '#f1f4f9', surface: '#ffffff', surfaceRaised: '#f6f8fc',
      sidebar: '#192437', sidebarRaised: '#29394f', sidebarText: '#edf3ff', sidebarMuted: '#a8b8d0',
      text: '#1b2b42', textSoft: '#45566e', textMuted: '#5f7087',
      line: '#dfe6f0', lineStrong: '#becbdc',
      accent: '#3567d4', accentStrong: '#2854b5', accentSoft: '#eaf0ff',
      danger: '#b8374e', success: '#267653'
    }
  },
  {
    id: 'paper', name: '暖纸', description: '柔和米白与琥珀色，像翻开一本手记。', mode: 'light',
    colors: {
      background: '#f0e9dd', surface: '#fffaf1', surfaceRaised: '#f6efe3',
      sidebar: '#342c24', sidebarRaised: '#4a3e31', sidebarText: '#fff1da', sidebarMuted: '#c6b49a',
      text: '#3b3026', textSoft: '#63513d', textMuted: '#79654e',
      line: '#e5d9c6', lineStrong: '#ccbaa0',
      accent: '#94602b', accentStrong: '#75481b', accentSoft: '#f4e5cc',
      danger: '#ae3940', success: '#517239'
    }
  },
  {
    id: 'moss', name: '青苔', description: '浅绿底色与森林绿，让阅读安静下来。', mode: 'light',
    colors: {
      background: '#eaf0e8', surface: '#f9fcf7', surfaceRaised: '#f0f5ec',
      sidebar: '#203b30', sidebarRaised: '#315243', sidebarText: '#eef8e9', sidebarMuted: '#b0c9b4',
      text: '#243b2e', textSoft: '#47624e', textMuted: '#5e7361',
      line: '#d5e1d0', lineStrong: '#afc5ac',
      accent: '#347553', accentStrong: '#255b3e', accentSoft: '#dfefdf',
      danger: '#b13c45', success: '#346d42'
    }
  },
  {
    id: 'bay', name: '海湾', description: '深海蓝绿与清亮青色，平静而有层次。', mode: 'dark',
    colors: {
      background: '#101f29', surface: '#172d39', surfaceRaised: '#203b47',
      sidebar: '#0d1b24', sidebarRaised: '#1b3440', sidebarText: '#e3f5f5', sidebarMuted: '#94b9c2',
      text: '#e3f2f2', textSoft: '#b6d1d5', textMuted: '#94b4bf',
      line: '#304b58', lineStrong: '#4f707d',
      accent: '#71d6ca', accentStrong: '#9ce8df', accentSoft: '#254b50',
      danger: '#ff9ba3', success: '#89d7a4'
    }
  },
  {
    id: 'midnight', name: '午夜', description: '墨蓝工作台与星光蓝，适合夜间专注。', mode: 'dark',
    colors: {
      background: '#111827', surface: '#1b2537', surfaceRaised: '#263248',
      sidebar: '#0c1220', sidebarRaised: '#202c42', sidebarText: '#eaf0ff', sidebarMuted: '#a2b0cc',
      text: '#e8edf8', textSoft: '#bdc9df', textMuted: '#9eadc8',
      line: '#35415a', lineStrong: '#53637f',
      accent: '#96b5ff', accentStrong: '#bacfff', accentSoft: '#2c3e63',
      danger: '#ff9eae', success: '#88d4af'
    }
  },
  {
    id: 'violet', name: '紫夜', description: '烟紫底色与薰衣草光泽，留一点创作氛围。', mode: 'dark',
    colors: {
      background: '#211b2d', surface: '#2d263c', surfaceRaised: '#3a304b',
      sidebar: '#191422', sidebarRaised: '#34283f', sidebarText: '#f4eaff', sidebarMuted: '#bca7d1',
      text: '#f0e8f8', textSoft: '#d0bfdc', textMuted: '#b8a3ca',
      line: '#4b3e5d', lineStrong: '#6d587f',
      accent: '#cfaff7', accentStrong: '#e2ceff', accentSoft: '#4a365f',
      danger: '#ffabbd', success: '#a9dba9'
    }
  }
]

module.exports = { themes }
