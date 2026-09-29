#!/usr/bin/env node
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/equicordplugins/sidebarChat/index.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const props = node => node.properties ?? [];
const value = (node, key) => props(node).find(p => p.name?.getText(tree) === key)?.initializer;
const plugin = tree.statements.find(node => ts.isExportAssignment(node)).expression.arguments[0];
const patches = value(plugin, "patches").elements;
const notificationPatch = patches.find(p => value(p, "find")?.text === 'notif_type:"MESSAGE_CREATE",notif_user_id:');
const utilityPatch = patches.find(p => value(p, "find")?.text === "NOTIFICATIONS_RECEIVED_RESPONSE");
assert(notificationPatch && utilityPatch);
const replacements = [value(notificationPatch, "replacement"), ...value(utilityPatch, "replacement").elements];
const canonicalize = regex => new RegExp(regex.source.replaceAll(/(\\*)\\i/g, (match, escapes) =>
    escapes.length % 2 ? match.slice(1) : `${escapes}(?:[A-Za-z_$][\\w$]*)`
), regex.flags);
const replace = (text, node) => {
    const match = canonicalize(vm.runInNewContext(value(node, "match").getText(tree)));
    const replacement = value(node, "replace").text;
    assert.equal((text.match(match) ?? []).length > 0, true, `patch missed: ${match}`);
    return text.replace(match, replacement);
};

// Accept a saved Discord bundle to exercise the real minified module, or run offline
// against exact representative excerpts from NotificationStore and NotificationUtils.
const realBundle = process.argv[2] && readFileSync(process.argv[2], "utf8");
const messages = realBundle ?? 'notif_type:"MESSAGE_CREATE",notif_user_id:a.author?.id,channel_id:d.id,guild_id:d.guild_id,{onClick(){(0,D.iN)(d.id),(d.type===ee.rbe.GUILD_VOICE||d.type===ee.rbe.GUILD_STAGE_VOICE)&&c.A.updateChatOpen(d.id,!0),_.default.clickedNotification()},isUserAvatar:!0}';
const native = realBundle ?? 'if(L.isPlatformEmbedded?y.Ay.focus():window.focus(),null!=e){e.options?.onClick?.(i)}';
const html = realBundle ?? 'L.isPlatformEmbedded?y.Ay.focus():(window.focus(),l.close()),r.omitClickTracking';
const patchedMessage = replace(messages, replacements[0]);
const patchedNative = replace(native, replacements[1]);
const patchedHtml = replace(html, replacements[2]);
assert.match(patchedMessage, /routeNotificationClick\(d\.id,d\.guild_id\?\?null/);
assert.match(patchedMessage, /clickedNotification\(\)/);
assert.match(patchedNative, /shouldDeferNotificationFocus\(e\?\.options\)/);
assert.match(patchedHtml, /shouldDeferNotificationFocus\(r\)/);
if (realBundle) new vm.Script(replace(replace(patchedMessage, replacements[1]), replacements[2]));

// Execute the production helper functions, not a restatement of their decision tree.
const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ["getNotificationTargetFocus", "shouldDeferNotificationFocus", "routeNotificationClick"].includes(node.name?.text));
const js = ts.transpileModule(functions.map(node => node.getText(tree)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;
const calls = [];
let result = true;
const context = vm.createContext({
    IS_EQUIBOP: true,
    VesktopNative: { win: { focusExistingNotificationTarget: async (channel, guild) => {
        calls.push([channel, guild]);
        if (result instanceof Error) throw result;
        return result;
    } } },
    window: { focus: () => calls.push("main") }
});
vm.runInContext(`${js}\nthis.helpers={routeNotificationClick,shouldDeferNotificationFocus}`, context);
const { routeNotificationClick, shouldDeferNotificationFocus } = context.helpers;
const original = () => calls.push("original");
assert.equal(shouldDeferNotificationFocus({ vcSidebarChatNotificationClick: true }), true);
assert.equal(shouldDeferNotificationFocus({}), false);
const nativeFocus = patchedNative.match(/\(\$self\.shouldDeferNotificationFocus\(e\?\.options\).*?\),null!=e/)?.[0].replace(/,null!=e$/, "");
const htmlFocus = patchedHtml.match(/\(\$self\.shouldDeferNotificationFocus\(r\).*?\),r\.omitClickTracking/)?.[0].replace(/,r\.omitClickTracking$/, "");
assert(nativeFocus && htmlFocus);
const focusContext = { $self: context.helpers, e: { options: { vcSidebarChatNotificationClick: true } }, r: { vcSidebarChatNotificationClick: true },
    L: { isPlatformEmbedded: true }, y: { Ay: { focus: () => calls.push("main") } },
    l: { close: () => calls.push("close") }, window: { focus: () => calls.push("main") } };
vm.runInNewContext(nativeFocus, focusContext);
assert.deepEqual(calls, []);
vm.runInNewContext(htmlFocus, focusContext);
assert.deepEqual(calls, ["close"]);
calls.length = 0;
focusContext.e.options = focusContext.r = {};
vm.runInNewContext(nativeFocus, focusContext);
vm.runInNewContext(htmlFocus, focusContext);
assert.deepEqual(calls, ["main", "main"]);
calls.length = 0;
await routeNotificationClick("thread", "guild", original)();
assert.deepEqual(calls, [["thread", "guild"]]);
calls.length = 0;
result = false;
await routeNotificationClick("channel", "guild", original)();
assert.deepEqual(calls, [["channel", "guild"], "main", "original"]);
calls.length = 0;
result = new Error("host unavailable");
await routeNotificationClick("dm", null, original)();
assert.deepEqual(calls, [["dm", null], "main", "original"]);
calls.length = 0;
delete context.VesktopNative.win.focusExistingNotificationTarget;
assert.equal(shouldDeferNotificationFocus({ vcSidebarChatNotificationClick: true }), false);
await routeNotificationClick("channel", "guild", original)();
assert.deepEqual(calls, ["main", "original"]);
console.log(`SidebarChat notification routing: patch matches and 4 click cases passed${realBundle ? " (Discord bundle)" : " (offline fixture)"}`);
