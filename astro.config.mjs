import membershipHeaders from './membership/build-headers.mjs';
import { defineConfig } from 'astro/config';
export default defineConfig({integrations:[membershipHeaders()], output: 'static', site: 'https://bigsoxstudios.com' });
