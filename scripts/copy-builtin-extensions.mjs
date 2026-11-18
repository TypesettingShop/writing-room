import { cp, lstat, readdir } from 'node:fs/promises';

const source = new URL('../extensions/', import.meta.url);
const output = new URL('../dist/extensions/', import.meta.url);

for (const folder of await readdir(source, { withFileTypes: true })) {
  if (!folder.isDirectory()) {
    continue;
  }
  const name = encodeURIComponent(folder.name) + '/';
  const directory = new URL(name, source);
  const files = await readdir(directory, { withFileTypes: true });
  if (files.some(file => file.name === 'package.json' && file.isFile())) {
    await cp(directory, new URL(name, output), {
      recursive: true,
      filter: async path => !(await lstat(path)).isSymbolicLink(),
    });
  }
}
