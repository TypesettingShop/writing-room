import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { scanBuiltinExtensions } from '../../extensionManagement/browser/builtinExtensionsScannerService.js';
import { IExtensionService } from '../common/extensions.js';
import { ExtensionService } from './extensionService.js';
import './extensions.css';

registerSingleton(IExtensionService, new SyncDescriptor(ExtensionService, [scanBuiltinExtensions]));
