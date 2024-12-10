"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const MidiEditor_1 = require("./MidiEditor");
function activate(context) {
    // Register our custom editor providers
    context.subscriptions.push(MidiEditor_1.MidiEditorProvider.register(context));
}
//# sourceMappingURL=extension.js.map