import js from '@eslint/js';
import globals from 'globals';
import eslintPluginAstro from 'eslint-plugin-astro';
export default [{ignores:['dist/**','.astro/**']},js.configs.recommended,...eslintPluginAstro.configs.recommended,{languageOptions:{globals:{...globals.browser,...globals.node}}}];
