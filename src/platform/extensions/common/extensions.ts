export class ExtensionIdentifier {
  readonly value: string;

  constructor(value: string) {
    this.value = value.toLowerCase();
  }

  static fromManifest(manifest: Pick<IExtensionManifest, 'publisher' | 'name'>): ExtensionIdentifier {
    return new ExtensionIdentifier(manifest.publisher + '.' + manifest.name);
  }
}

export interface ICommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly enablement?: string;
}

export interface IMenuContribution {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
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

export interface IViewContainerContribution {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
}

export interface IViewContribution {
  readonly id: string;
  readonly name: string;
  readonly when?: string;
}

export interface IExtensionContributions {
  readonly commands?: readonly ICommandContribution[];
  readonly menus?: Readonly<Record<string, readonly IMenuContribution[]>>;
  readonly keybindings?: readonly IKeybindingContribution[];
  readonly viewsContainers?: Readonly<Record<string, readonly IViewContainerContribution[]>>;
  readonly views?: Readonly<Record<string, readonly IViewContribution[]>>;
}

export interface IExtensionManifest {
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly displayName?: string;
  readonly browser?: string;
  readonly icon?: string;
  readonly activationEvents?: readonly string[];
  readonly contributes?: IExtensionContributions;
}

export interface IExtensionDescription {
  readonly identifier: ExtensionIdentifier;
  readonly location: string;
  readonly manifest: IExtensionManifest;
  readonly isBuiltin: boolean;
}

export interface IExtensionMessage {
  readonly extensionId: string;
  readonly severity: 'info' | 'warn' | 'error';
  readonly path: string;
  readonly message: string;
  readonly invalidResource?: boolean;
}
