import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setLanguage, SUPPORTED_LANGUAGES } from '@/config/i18n'

function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const [show, setShow] = useState(false)

  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === i18n.language) || SUPPORTED_LANGUAGES[0]

  return (
    <div className="relative">
      <button
        onClick={() => setShow(!show)}
        className="px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm transition-colors flex items-center gap-1"
        title={currentLang.name}
      >
        🌐
      </button>

      {show && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShow(false)} />
          <div className="absolute top-full right-0 mt-1 w-28 bg-white rounded-xl shadow-xl border border-gray-200 z-50 p-1">
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => {
                  setLanguage(lang.code)
                  setShow(false)
                }}
                className={`w-full px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  i18n.language === lang.code
                    ? 'bg-emerald-50 text-emerald-700 font-semibold'
                    : 'hover:bg-gray-50 text-gray-700'
                }`}
              >
                {lang.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default LanguageSwitcher
