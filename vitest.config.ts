import { defineConfig, mergeConfig } from 'vitest/config';
import { browserConfig } from './vite.config.js';

export default mergeConfig(browserConfig, defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/test/**/*.test.ts', 'server/**/test/**/*.test.ts'],
  },
}));
