// Styled Markdown became Semantic Markdown in 3.0, with a new extension ID. The old extension (2.x) registers the same
// commands, language and preview hooks, so the two can't run side by side: while it is enabled, this one stays idle
// and asks to uninstall it. The old ID's own 3.x release is a small stub that installs this extension and removes
// itself, so it doesn't count.
import * as vscode from 'vscode';
import { isFullOldExtension, OLD_EXTENSION_ID } from './oldExtension';

/** True when the full old extension is enabled. Then it asks the user to uninstall it, and activation should stop. */
export function oldExtensionIsActive(): boolean {
  const old = vscode.extensions.getExtension(OLD_EXTENSION_ID);
  if (!old || !isFullOldExtension((old.packageJSON as { version?: unknown }).version)) return false;
  const uninstall = 'Uninstall Styled Markdown';
  void vscode.window
    .showWarningMessage(
      'Styled Markdown is now Semantic Markdown. Uninstall the old Styled Markdown extension, then reload, to use this one. '
        + 'Your settings carry over.',
      uninstall,
    )
    .then(async (choice) => {
      if (choice !== uninstall) return;
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  return true;
}
