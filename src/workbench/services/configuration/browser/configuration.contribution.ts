// The real configuration service: settings.json in browser storage, over the registry's defaults.
import './configurationService.js';
// Extensions contribute settings and default overrides through their manifests.
import '../../../api/common/configurationExtensionPoint.js';
