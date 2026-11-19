/** Writes VSIX packages for tests, on top of the ZIP test writer. */
import { createZip, type ZipTestEntry, type ZipTestOptions } from '../../../../base/test/common/zipTestUtils.js';

export const sampleManifest = Object.freeze({
  name: 'sample',
  publisher: 'tester',
  version: '1.0.0',
  engines: { vscode: '^1.80.0' },
  browser: './dist/web.js',
});

export interface VsixTestOptions {
  /** extension/package.json: an object is written as JSON, a string as is, null leaves the file out. Default sampleManifest. */
  readonly manifest?: object | string | null;
  /** Files under extension/, by relative path. Default: dist/web.js. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** extension.vsixmanifest: a string is written as is, null leaves it out. Default: one without TargetPlatform. */
  readonly vsixManifest?: string | null;
  /** Writes TargetPlatform into the default extension.vsixmanifest. */
  readonly targetPlatform?: string;
  /** More entries, written after the others with their names as given. */
  readonly entries?: readonly ZipTestEntry[];
  readonly zip?: ZipTestOptions;
}

export function vsixManifestXml(targetPlatform?: string): string {
  const platform = targetPlatform === undefined ? '' : ` TargetPlatform="${targetPlatform}"`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="sample" Version="1.0.0" Publisher="tester"${platform}/>`,
    '    <DisplayName>Sample</DisplayName>',
    '  </Metadata>',
    '</PackageManifest>',
  ].join('\n');
}

export function createVsix(options: VsixTestOptions = {}): Uint8Array<ArrayBuffer> {
  const entries: ZipTestEntry[] = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="utf-8"?><Types/>' },
  ];
  const vsixManifest = options.vsixManifest === undefined ? vsixManifestXml(options.targetPlatform) : options.vsixManifest;
  if (vsixManifest !== null) {
    entries.push({ name: 'extension.vsixmanifest', data: vsixManifest });
  }
  const manifest = options.manifest === undefined ? sampleManifest : options.manifest;
  if (manifest !== null) {
    entries.push({ name: 'extension/package.json', data: typeof manifest === 'string' ? manifest : JSON.stringify(manifest, undefined, 2) });
  }
  for (const [path, data] of Object.entries(options.files ?? { 'dist/web.js': 'exports.activate = () => {};\n' })) {
    entries.push({ name: 'extension/' + path, data });
  }
  return createZip([...entries, ...options.entries ?? []], options.zip);
}
