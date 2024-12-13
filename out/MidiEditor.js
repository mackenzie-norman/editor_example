"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MidiEditorProvider = void 0;
const vscode = require("vscode");
const dispose_1 = require("./dispose");
const util_1 = require("./util");
const fs = require("fs");
const midi_1 = require("@tonejs/midi");
/**
 * Define the type of edits used in paw draw files.
 r*/
function note_to_json(note) {
    let end_string = "{";
    end_string += ("\"note\" : " + note.midi);
    end_string += (", \"time\" : " + note.time + " , \"velocity\": " + note.velocity + ", \"duration\": " + note.duration + "}");
    //console.log(end_string);
    return end_string;
}
function midi_to_text(midi) {
    let end_string = "{";
    //"<h1>" + midi.name + "</h1>";
    let trackC = 0;
    midi.tracks.forEach(track => {
        //end_string += JSON.stringify(track_json);
        //end_string +="<h1>track " + trackC + "</h1>";
        end_string += "\"track" + trackC + "\" : [";
        //console.log(track.notes); // Array of notes in the track
        track.notes.forEach(note => {
            end_string += note_to_json(note) + " , ";
        });
        end_string = end_string.slice(0, -2);
        console.log(track.controlChanges); // Control changes in the track
        end_string += "] , ";
        trackC += 1;
    });
    end_string = end_string.slice(0, -2);
    end_string += "}";
    const json_version = JSON.parse(end_string);
    return JSON.stringify(json_version, null, 2);
}
/**
 * Define the document (the data model) used for paw draw files.
 */
class MidiDocument extends dispose_1.Disposable {
    static async create(uri, backupId, delegate) {
        // If we have a backup, read that. Otherwise read the resource from the workspace
        const dataFile = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
        const fileData = await MidiDocument.readFile(dataFile);
        return new MidiDocument(uri, fileData, delegate);
    }
    static async readFile(uri) {
        if (uri.scheme === 'untitled') {
            return new Uint8Array();
        }
        return new Uint8Array(await vscode.workspace.fs.readFile(uri));
    }
    constructor(uri, initialContent, delegate) {
        super();
        this._edits = [];
        this._savedEdits = [];
        this._onDidDispose = this._register(new vscode.EventEmitter());
        /**
         * Fired when the document is disposed of.
         */
        this.onDidDispose = this._onDidDispose.event;
        this._onDidChangeDocument = this._register(new vscode.EventEmitter());
        /**
         * Fired to notify webviews that the document has changed.
         */
        this.onDidChangeContent = this._onDidChangeDocument.event;
        this._onDidChange = this._register(new vscode.EventEmitter());
        /**
         * Fired to tell VS Code that an edit has occurred in the document.
         *
         * This updates the document's dirty indicator.
         */
        this.onDidChange = this._onDidChange.event;
        this._uri = uri;
        this._documentData = initialContent;
        this._delegate = delegate;
    }
    get uri() { return this._uri; }
    get documentData() { return this._documentData; }
    /**
     * Called by VS Code when there are no more references to the document.
     *
     * This happens when all editors for it have been closed.
     */
    dispose() {
        this._onDidDispose.fire();
        super.dispose();
    }
    /**
     * Called when the user edits the document in a webview.
     *
     * This fires an event to notify VS Code that the document has been edited.
     */
    makeEdit(edit) {
        this._edits.push(edit);
        this._onDidChange.fire({
            label: 'Stroke',
            undo: async () => {
                this._edits.pop();
                this._onDidChangeDocument.fire({
                    edits: this._edits,
                });
            },
            redo: async () => {
                this._edits.push(edit);
                this._onDidChangeDocument.fire({
                    edits: this._edits,
                });
            }
        });
    }
    /**
     * Called by VS Code when the user saves the document.
     */
    async save(cancellation) {
        await this.saveAs(this.uri, cancellation);
        this._savedEdits = Array.from(this._edits);
    }
    /**
     * Called by VS Code when the user saves the document to a new location.
     */
    async saveAs(targetResource, cancellation) {
        const fileData = await this._delegate.getFileData();
        if (cancellation.isCancellationRequested) {
            return;
        }
        await vscode.workspace.fs.writeFile(targetResource, fileData);
    }
    /**
     * Called by VS Code when the user calls `revert` on a document.
     */
    async revert(_cancellation) {
        const diskContent = await MidiDocument.readFile(this.uri);
        this._documentData = diskContent;
        this._edits = this._savedEdits;
        this._onDidChangeDocument.fire({
            content: diskContent,
            edits: this._edits,
        });
    }
    /**
     * Called by VS Code to backup the edited document.
     *
     * These backups are used to implement hot exit.
     */
    async backup(destination, cancellation) {
        await this.saveAs(destination, cancellation);
        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(destination);
                }
                catch {
                    // noop
                }
            }
        };
    }
}
/**
 * Provider for paw draw editors.
 *
 * Paw draw editors are used for `.pawDraw` files, which are just `.png` files with a different file extension.
 *
 * This provider demonstrates:
 *
 * - How to implement a custom editor for binary files.
 * - Setting up the initial webview for a custom editor.
 * - Loading scripts and styles in a custom editor.
 * - Communication between VS Code and the custom editor.
 * - Using CustomDocuments to store information that is shared between multiple custom editors.
 * - Implementing save, undo, redo, and revert.
 * - Backing up a custom editor.
 */
class MidiEditorProvider {
    static register(context) {
        return vscode.window.registerCustomEditorProvider(MidiEditorProvider.viewType, new MidiEditorProvider(context), {
            // For this demo extension, we enable `retainContextWhenHidden` which keeps the
            // webview alive even when it is not visible. You should avoid using this setting
            // unless is absolutely required as it does have memory overhead.
            webviewOptions: {
                retainContextWhenHidden: false,
            },
            supportsMultipleEditorsPerDocument: false,
        });
    }
    constructor(_context) {
        this._context = _context;
        /**
         * Tracks all known webviews
         */
        this.webviews = new WebviewCollection();
        this._onDidChangeCustomDocument = new vscode.EventEmitter();
        this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
        this._requestId = 1;
        this._callbacks = new Map();
    }
    //#region CustomEditorProvider
    async openCustomDocument(uri, openContext, _token) {
        const document = await MidiDocument.create(uri, openContext.backupId, {
            getFileData: async () => {
                const webviewsForDocument = Array.from(this.webviews.get(document.uri));
                if (!webviewsForDocument.length) {
                    throw new Error('Could not find webview to save for');
                }
                const panel = webviewsForDocument[0];
                const response = await this.postMessageWithResponse(panel, 'getFileData', {});
                return new Uint8Array(response);
            }
        });
        const listeners = [];
        listeners.push(document.onDidChange(e => {
            // Tell VS Code that the document has been edited by the use.
            this._onDidChangeCustomDocument.fire({
                document,
                ...e,
            });
        }));
        listeners.push(document.onDidChangeContent(e => {
            // Update all webviews when the document changes
            for (const webviewPanel of this.webviews.get(document.uri)) {
                this.postMessage(webviewPanel, 'update', {
                    edits: e.edits,
                    content: e.content,
                });
            }
        }));
        document.onDidDispose(() => (0, dispose_1.disposeAll)(listeners));
        return document;
    }
    async resolveCustomEditor(document, webviewPanel, _token) {
        // Add the webview to our internal set of active webviews
        this.webviews.add(document.uri, webviewPanel);
        // Setup initial content for the webview
        webviewPanel.webview.options = {
            enableScripts: true,
        };
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);
        webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, e));
        // Wait for the webview to be properly ready before we init
        webviewPanel.webview.onDidReceiveMessage(e => {
            if (e.type === 'ready') {
                if (document.uri.scheme === 'untitled') {
                    this.postMessage(webviewPanel, 'init', {
                        untitled: true,
                        editable: true,
                    });
                }
                else {
                    const editable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme);
                    this.postMessage(webviewPanel, 'init', {
                        value: document.documentData,
                        editable,
                    });
                }
            }
        });
    }
    saveCustomDocument(document, cancellation) {
        return document.save(cancellation);
    }
    saveCustomDocumentAs(document, destination, cancellation) {
        return document.saveAs(destination, cancellation);
    }
    revertCustomDocument(document, cancellation) {
        return document.revert(cancellation);
    }
    backupCustomDocument(document, context, cancellation) {
        return document.backup(context.destination, cancellation);
    }
    //#endregion
    getMidiFromDocument(document) {
        const filePath = document.uri.fsPath;
        //const text = document.getText();
        try {
            const midiData = fs.readFileSync(filePath);
            const midi = new midi_1.Midi(midiData);
            console.log(midi);
            return midi.toJSON();
        }
        catch {
            return {};
        }
    }
    /**
     * Get the static HTML used for in our editor's webviews.
     */
    getHtmlForWebview(webview, document) {
        // Local path to script and css for the webview
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'vscode.css'));
        const scriptPathOnDisk = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'midi_player.js');
        // And the uri we use to load this script in the webview
        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
        const midiScriptPathOnDisk = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'MIDIFile.js');
        // And the uri we use to load this script in the webview
        const midiScriptUri = webview.asWebviewUri(midiScriptPathOnDisk);
        // Use a nonce to whitelist which scripts can be run
        const nonce = (0, util_1.getNonce)();
        //const midi = this.getMidiFromDocument(document);
        //const info_str = midi_to_text(midi);
        const info_str = "WIP";
        const docuri = webview.asWebviewUri(document.uri);
        console.log(info_str);
        return /* html */ `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				
				

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				
				<link href="${styleVSCodeUri}" rel="stylesheet" />
				<script src='https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js'></script>
				<script nonce="${nonce}" src="${midiScriptUri}"></script>
				<title>Midi Editor</title>
			</head>
			<body>
			<div id='cntls'></div>
			<hr />
			<div id ="info" ></div>
			<p><a href="https://surikov.github.io/webaudiofont/">source</a></p>
			<script nonce="${nonce}" src="${scriptUri}"></script>
			<script nonce = "${nonce}" >handleExample("${docuri}")</script>
			</body>
			</html>`;
    }
    postMessageWithResponse(panel, type, body) {
        const requestId = this._requestId++;
        const p = new Promise(resolve => this._callbacks.set(requestId, resolve));
        panel.webview.postMessage({ type, requestId, body });
        return p;
    }
    postMessage(panel, type, body) {
        panel.webview.postMessage({ type, body });
    }
    onMessage(document, message) {
        switch (message.type) {
            case 'response':
                {
                    const callback = this._callbacks.get(message.requestId);
                    callback?.(message.body);
                    return;
                }
        }
    }
}
exports.MidiEditorProvider = MidiEditorProvider;
//TODO change
MidiEditorProvider.viewType = 'midiEditor.midi';
/**
 * Tracks all webviews.
 */
class WebviewCollection {
    constructor() {
        this._webviews = new Set();
    }
    /**
     * Get all known webviews for a given uri.
     */
    *get(uri) {
        const key = uri.toString();
        for (const entry of this._webviews) {
            if (entry.resource === key) {
                yield entry.webviewPanel;
            }
        }
    }
    /**
     * Add a new webview to the collection.
     */
    add(uri, webviewPanel) {
        const entry = { resource: uri.toString(), webviewPanel };
        this._webviews.add(entry);
        webviewPanel.onDidDispose(() => {
            this._webviews.delete(entry);
        });
    }
}
//# sourceMappingURL=MidiEditor.js.map