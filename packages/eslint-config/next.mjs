// @ts-check
import { FlatCompat } from '@eslint/eslintrc';
import { base } from './base.mjs';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// next/core-web-vitals doit être appliqué avant `base` : sinon son parser
// écrase celui de typescript-eslint et casse la détection d'usage des types
// (faux positifs no-unused-vars sur les imports utilisés uniquement comme types).
export default [...compat.extends('next/core-web-vitals'), ...base];
