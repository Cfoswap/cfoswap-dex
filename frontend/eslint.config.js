import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'src/pages/Deploy/data/deploy_artifacts.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // eslint-plugin-react-hooks v7: 使用最新的 flat recommended 配置（含 React Compiler 友好规则）
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactRefresh.configs.vite.rules,
      // 工程规范：禁止 any，未知类型用 unknown + 类型收窄
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // 关闭与 Prettier 冲突的格式类规则，交由 Prettier 格式化
  prettier,
)