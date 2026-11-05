// The last release under the old ID, bislink360.styled-markdown. It contributes nothing: its extensionDependencies
// make VS Code install bislink360.semantic-markdown, and it offers to uninstall itself once.
const vscode = require('vscode');

const SELF = 'bislink360.styled-markdown';
const ASKED = 'askedToUninstall';

function activate(context) {
  if (context.globalState.get(ASKED)) return;
  void context.globalState.update(ASKED, true);
  const uninstall = 'Uninstall Styled Markdown';
  void vscode.window
    .showInformationMessage(
      'Styled Markdown is now Semantic Markdown, and the Semantic Markdown extension is installed. Your settings carry over. '
        + 'You can uninstall the old Styled Markdown entry.',
      uninstall,
    )
    .then((choice) => {
      if (choice === uninstall) return vscode.commands.executeCommand('workbench.extensions.uninstallExtension', SELF);
      return undefined;
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
