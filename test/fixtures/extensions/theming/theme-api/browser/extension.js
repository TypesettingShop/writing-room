const vscode = require('vscode');

let changes = 0;

module.exports.activate = context => {
  const kind = vscode.window.createStatusBarItem('kind', vscode.StatusBarAlignment.Left, 100);
  const show = () => {
    kind.text = 'Kind ' + vscode.window.activeColorTheme.kind + ', changes ' + changes;
    kind.name = 'Theme kind';
  };
  show();
  kind.show();
  context.subscriptions.push(kind, vscode.window.onDidChangeActiveColorTheme(theme => {
    changes++;
    show();
    // The event's theme is the active one.
    if (theme !== vscode.window.activeColorTheme) {
      kind.text += ' (stale)';
    }
  }));

  const build = vscode.window.createStatusBarItem('build', vscode.StatusBarAlignment.Left, 90);
  build.text = 'Build';
  build.name = 'Build status';
  build.color = '#00ff00';
  build.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  build.accessibilityInformation = { label: 'Build failed with 3 errors', role: 'link' };
  build.tooltip = new vscode.MarkdownString('**3 errors** <img src="x" onerror="document.title = \'hacked\'">');
  build.command = 'themeApi.report';
  build.show();

  const accent = vscode.window.createStatusBarItem('accent', vscode.StatusBarAlignment.Left, 80);
  accent.text = 'Accent';
  accent.name = 'Accent status';
  accent.color = new vscode.ThemeColor('themeApi.accent');
  accent.backgroundColor = new vscode.ThemeColor('editor.background');
  accent.show();

  const hex = vscode.window.createStatusBarItem('hex', vscode.StatusBarAlignment.Left, 70);
  hex.text = 'Hex';
  hex.name = 'Hex status';
  hex.color = '#ff8800';
  hex.show();

  const bad = vscode.window.createStatusBarItem('bad', vscode.StatusBarAlignment.Left, 60);
  bad.text = 'Bad';
  bad.name = 'Bad status';
  bad.color = 'red; background: url(https://example.invalid/x.png)';
  bad.show();

  context.subscriptions.push(build, accent, hex, bad, vscode.commands.registerCommand('themeApi.report', () => {
    void vscode.window.showInformationMessage('Theme kind ' + vscode.window.activeColorTheme.kind);
  }));
};
