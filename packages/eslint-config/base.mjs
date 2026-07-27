// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // Volontairement désactivée : son autofix convertit en `import type` des classes
      // injectées par le DI NestJS (design:paramtypes a alors besoin de la valeur réelle,
      // pas seulement du type), et elle nécessite un typed-linting non configuré côté
      // Next.js (crash avec eslint-config-next). Voir CLAUDE.md.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      '.next/**',
      '.turbo/**',
      'node_modules/**',
      'coverage/**',
      '**/jest.config.cjs',
      '**/next-env.d.ts',
    ],
  },
);

export default base;
