import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const codiconModule = 'virtual:codicon-names';
const resolvedCodiconModule = '\0' + codiconModule;

export default defineConfig({
  appType: 'mpa',
  plugins: [
    {
      name: 'codicon-names',
      resolveId(id) {
        return id === codiconModule ? resolvedCodiconModule : undefined;
      },
      load(id) {
        if (id !== resolvedCodiconModule) {
          return;
        }
        // The CSS includes aliases for glyphs that the font's CSV lists only once.
        const css = readFileSync(require.resolve('@vscode/codicons/dist/codicon.css'), 'utf8');
        const names = Array.from(
          css.matchAll(/\.codicon-([a-z0-9-]+)::?before\s*\{\s*content:/gi),
          match => match[1],
        );
        if (names.length === 0) {
          throw new Error('Could not read icon names from the Codicons stylesheet.');
        }
        return 'export default ' + JSON.stringify(names);
      },
    },
    {
      name: 'third-party-notices',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'ThirdPartyNotices.txt',
          source: readFileSync(new URL('./ThirdPartyNotices.txt', import.meta.url)),
        });
      },
    },
  ],
});
