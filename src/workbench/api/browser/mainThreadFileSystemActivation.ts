import { Disposable } from '../../../base/common/lifecycle.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { registerWorkbenchContribution2 } from '../../common/contributions.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { isExtensionFileSystemScheme } from '../common/extHostFileSystemSchemes.js';

export function fileSystemActivationEvent(extensions: IExtensionService, scheme: string): string | undefined {
  if (isExtensionFileSystemScheme(scheme)) {
    const event = `onFileSystem:${scheme}`;
    if (extensions.extensions?.some(extension => extension.manifest.browser && extension.manifest.activationEvents?.includes(event))) {
      return event;
    }
  }
}

class FileSystemActivation extends Disposable {
  constructor(@IFileService files: IFileService, @IExtensionService extensions: IExtensionService) {
    super();
    this._register(files.onWillActivateFileSystemProvider(({ scheme, join }) => {
      const event = fileSystemActivationEvent(extensions, scheme);
      if (event) {
        join(extensions.activateByEvent(event));
      }
    }));
  }
}

// File service calls can start the extension host, so this listener belongs to the workbench lifetime.
registerWorkbenchContribution2('workbench.contrib.fileSystemActivation', FileSystemActivation);
