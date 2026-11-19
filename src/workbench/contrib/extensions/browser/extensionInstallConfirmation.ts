import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { product } from '../../../../platform/product/common/product.js';
import type { PackageInstallConfirmation } from '../../../services/extensionManagement/common/extensionManagementService.js';

export const sourceNames = { location: 'folder URL', vsix: 'VSIX', gallery: 'Open VSX' } as const;

export async function confirmPackage(
  quickInput: IQuickInputService,
  confirmation: PackageInstallConfirmation,
  signal?: AbortSignal,
): Promise<boolean> {
  const { manifest, source, existing, signature } = confirmation;
  const name = confirmation.displayName;
  const gallery = source.kind === 'gallery' ? source : undefined;
  const action = !confirmation.isWebExtension ? 'Install Contributions Only'
    : gallery && existing && existing.version !== manifest.version ? 'Update'
      : existing?.version === manifest.version ? 'Reinstall' : existing ? 'Replace' : 'Install';
  const warning = gallery && (signature === 'unsigned' ? 'Warning: This package has no signature.'
    : signature === 'unverifiable' ? 'Warning: This browser could not verify the Ed25519 signature.' : undefined);
  const facts = [
    ...confirmation.isWebExtension ? gallery ? ['Web extension'] : [] : ['Not a web extension: only its contributions apply.'],
    ...existing ? [existing.version === manifest.version
      ? `Reinstalls version ${existing.version}.`
      : `Replaces version ${existing.version} (${sourceNames[existing.source]}).`] : [],
    `Source: ${source.label}`,
    ...gallery ? [
      `Download host: ${gallery.host}`,
      `License: ${typeof manifest.license === 'string' ? manifest.license : gallery.license ?? 'Unknown'}`,
    ] : [],
    `Size: ${confirmation.size} bytes`,
    `SHA-256: ${confirmation.sha256}`,
    `Signature: ${signature}${gallery?.keyId ? ' (' + gallery.keyId + ')' : ''}`,
    ...gallery && signature === 'verified' ? ['The key comes from Open VSX during installation. Verification detects changes in transit or at the CDN. A compromised registry could provide both a changed package and key.'] : [],
    ...gallery && manifest.extensionDependencies?.length ? ['Dependencies: ' + manifest.extensionDependencies.join(', ')] : [],
    `engines.vscode ${confirmation.engine} is compatible with ${product.version}`,
    ...confirmation.persistent ? [] : ['Browser storage is unavailable: the extension stays for this session only.'],
    ...confirmation.warnings,
    'Extension code can make requests as this page’s origin.',
  ];
  const items = [
    { id: 'cancel', label: 'Cancel' },
    {
      id: 'install', label: action,
      description: `${name} · ${manifest.publisher} · ${manifest.version} · ${confirmation.identifier}`,
      detail: facts.join(' · '),
    },
  ];
  const title = warning || `${action} extension from ${source.label}`;
  if (!signal) {
    return (await quickInput.pick(items, { title }))?.id === 'install';
  }
  signal.throwIfAborted();
  return new Promise(resolve => {
    const picker = quickInput.createQuickPick<IQuickPickItem>();
    picker.title = title;
    picker.ignoreFocusOut = true;
    picker.items = items;
    picker.activeItems = [items[0]];
    let accepted = false;
    const abort = () => picker.hide();
    const finish = () => {
      signal.removeEventListener('abort', abort);
      picker.dispose();
      resolve(accepted && !signal.aborted);
    };
    picker.onDidAccept(() => {
      accepted = picker.selectedItems[0]?.id === 'install';
      picker.hide();
    });
    picker.onDidHide(finish);
    signal.addEventListener('abort', abort, { once: true });
    picker.show();
    if (!picker.visible) {
      finish();
    }
  });
}
