// @ts-check
import tseslint from 'typescript-eslint';
import { base } from './base.mjs';

export default tseslint.config(...base, {
  rules: {
    '@typescript-eslint/no-extraneous-class': 'off',
  },
});
