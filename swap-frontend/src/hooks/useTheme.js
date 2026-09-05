/**
 * Custom Hook for day/night theme switching
 * - Initial value: localStorage.cfoswap_theme, defaults to light if not set
 * - Switching method: modify both document.documentElement's data-theme attribute + dark class
 * - With Tailwind darkMode: 'class', the dark: prefix can be used directly
 * - CSS variables like var(--color-bg-primary) used in components will automatically follow the theme
 */
import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'cfoswap_theme';
const VALID_THEMES = ['light', 'dark'];

function getInitialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && VALID_THEMES.includes(saved)) return saved;
  } catch { /* storage not available */ }
  return 'light'; // Default day mode
}

function applyThemeToDocument(theme) {
  const root = document.documentElement;
  // data-theme attribute, used by CSS [data-theme="dark"] and [data-theme="light"]
  root.setAttribute('data-theme', theme);
  // dark class relied on by Tailwind darkMode='class'
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  // Also sync the attribute on body for debugging/styling convenience
  document.body && document.body.setAttribute('data-theme', theme);
}

function persistTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* ignore */ }
}

export default function useTheme() {
  const [theme, setThemeState] = useState(getInitialTheme);

  // Apply once on initial mount to ensure style consistency immediately after refresh
  useEffect(() => {
    applyThemeToDocument(theme);
  }, []);

  const setTheme = useCallback((nextTheme) => {
    if (!VALID_THEMES.includes(nextTheme)) return;
    setThemeState(nextTheme);
    applyThemeToDocument(nextTheme);
    persistTheme(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  }, [theme, setTheme]);

  return {
    theme,                           // 'light' | 'dark'
    isLight: theme === 'light',
    isDark: theme === 'dark',
    setTheme,                        // Explicitly set
    toggleTheme,                     // Day ⇄ Night toggle (most commonly used)
  };
}
