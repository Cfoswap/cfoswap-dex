import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales-zh'
import enUS from './locales-en'
import jaJP from './locales-ja'
import koKR from './locales-ko'
import viVN from './locales-vi'
import ruRU from './locales-ru'
import arSA from './locales-ar'

export type SupportedLanguage = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR' | 'vi-VN' | 'ru-RU' | 'ar-SA'

// 获取浏览器/系统语言，匹配支持的语言
function getBrowserLanguage(): SupportedLanguage {
  const browserLang = navigator.language || (navigator as { userLanguage?: string }).userLanguage || 'en-US'
  // 直接匹配
  if (['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'vi-VN', 'ru-RU', 'ar-SA'].includes(browserLang)) {
    return browserLang as SupportedLanguage
  }
  // 匹配语言前缀（例如 zh-TW -> zh-CN, en-GB -> en-US）
  const langPrefix = browserLang.split('-')[0]
  const prefixMap: Record<string, SupportedLanguage> = {
    zh: 'zh-CN',
    en: 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    vi: 'vi-VN',
    ru: 'ru-RU',
    ar: 'ar-SA'
  }
  return prefixMap[langPrefix] || 'en-US'
}

const savedLang = localStorage.getItem('cfolock_lang') as SupportedLanguage | null
const defaultLang: SupportedLanguage = savedLang || getBrowserLanguage()

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
    'ja-JP': { translation: jaJP },
    'ko-KR': { translation: koKR },
    'vi-VN': { translation: viVN },
    'ru-RU': { translation: ruRU },
    'ar-SA': { translation: arSA }
  },
  lng: defaultLang,
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false
  }
})

export default i18n

export function setLanguage(lang: SupportedLanguage) {
  i18n.changeLanguage(lang)
  localStorage.setItem('cfolock_lang', lang)
  // RTL 支持：阿拉伯语从右到左
  document.documentElement.dir = lang === 'ar-SA' ? 'rtl' : 'ltr'
  document.documentElement.lang = lang
}

// 初始化 RTL 设置
if (defaultLang === 'ar-SA') {
  document.documentElement.dir = 'rtl'
  document.documentElement.lang = defaultLang
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en-US' as SupportedLanguage, name: 'English', shortName: 'EN' },
  { code: 'ja-JP' as SupportedLanguage, name: '日本語', shortName: '日' },
  { code: 'ko-KR' as SupportedLanguage, name: '한국어', shortName: '한' },
  { code: 'vi-VN' as SupportedLanguage, name: 'Tiếng Việt', shortName: '越' },
  { code: 'ru-RU' as SupportedLanguage, name: 'Русский', shortName: 'Ru' },
  { code: 'ar-SA' as SupportedLanguage, name: 'العربية', shortName: 'ع' },
  { code: 'zh-CN' as SupportedLanguage, name: '中文', shortName: '中' }
]
