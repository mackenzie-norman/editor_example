import * as vscode from 'vscode';
import { MidiEditorProvider } from './MidiEditor';

export function activate(context: vscode.ExtensionContext) {
	// Register our custom editor providers
	
	context.subscriptions.push(MidiEditorProvider.register(context));
}
