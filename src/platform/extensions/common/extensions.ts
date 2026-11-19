export class ExtensionIdentifier {
  readonly value: string;

  constructor(value: string) {
    this.value = value.toLowerCase();
  }

  static fromManifest(manifest: Pick<IExtensionManifest, 'publisher' | 'name'>): ExtensionIdentifier {
    return new ExtensionIdentifier(manifest.publisher + '.' + manifest.name);
  }
}

export interface IKeybindingContribution {
  readonly command: string;
  readonly key: string;
  readonly mac?: string;
  readonly win?: string;
  readonly linux?: string;
  readonly when?: string;
  readonly args?: unknown;
}

export type IExtensionContributions = Readonly<Record<string, unknown>>;

export interface IExtensionManifest {
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly displayName?: string;
  readonly browser?: string;
  readonly main?: string;
  readonly extensionKind?: 'ui' | 'workspace' | 'web' | readonly ('ui' | 'workspace' | 'web')[];
  readonly engines?: { readonly vscode?: string; readonly [engine: string]: string | undefined };
  readonly extensionDependencies?: readonly string[];
  readonly extensionPack?: readonly string[];
  readonly enabledApiProposals?: readonly string[];
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly l10n?: string;
  readonly license?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly activationEvents?: readonly string[];
  readonly contributes?: IExtensionContributions;
}

export interface IExtensionDescription {
  readonly identifier: ExtensionIdentifier;
  readonly location: string;
  readonly manifest: IExtensionManifest;
  readonly isBuiltin: boolean;
  readonly nls?: Readonly<Record<string, string>>;
}

export interface IExtensionMessage {
  readonly extensionId: string;
  readonly severity: 'info' | 'warn' | 'error';
  readonly path: string;
  readonly message: string;
  readonly invalidResource?: boolean;
}
