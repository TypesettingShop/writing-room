// Platform and workbench services
import './platformServices.contribution.js';

// Workbench parts and editor contributions
import './browser/workbench.contribution.js';
import './browser/parts/editor/editor.contribution.js';

// Commands, menus and keybindings
import './browser/parts/titlebar/menubar.contribution.js';
import './browser/parts/editor/editorHistory.contribution.js';
import './contrib/quickaccess/browser/quickAccess.contribution.js';

// Extensions
import './services/extensions/browser/extensions.contribution.js';
import './api/browser/extensionHost.contribution.js';
import './contrib/extensions/browser/extensions.contribution.js';

import './services/language/browser/language.contribution.js';
import './contrib/markers/browser/markers.contribution.js';
import './contrib/files/browser/files.contribution.js';
import './contrib/webview/browser/webview.contribution.js';
import './services/configuration/browser/configuration.contribution.js';
import './contrib/output/browser/output.contribution.js';
import './services/themes/browser/themes.contribution.js';
import './contrib/search/browser/search.contribution.js';
import './contrib/customEditor/browser/customEditor.contribution.js';
import './contrib/markdownEditor/browser/markdownEditor.contribution.js';
import './contrib/markdownEditor/browser/markdownEditorPresentation.contribution.js';

// Preferences
import './contrib/preferences/browser/preferences.contribution.js';
