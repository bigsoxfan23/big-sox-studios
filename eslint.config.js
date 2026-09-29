import js from '@eslint/js';
import globals from 'globals';
import eslintPluginAstro from 'eslint-plugin-astro';
export default [js.configs.recommended,...eslintPluginAstro.configs.recommended,{languageOptions:{globals:{...globals.browser,...globals.node}},ignores:['dist/','.astro/']}];
