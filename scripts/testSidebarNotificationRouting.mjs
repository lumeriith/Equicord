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
const getPatch = find => {
    const patch = patches.find(p => value(p, "find")?.text === find);
    assert(patch, `missing patch ${find}`);
    return value(patch, "replacement");
};
const messagePatch = getPatch('notif_type:"MESSAGE_CREATE",notif_user_id:');
const wrapperPatch = getPatch('type:"NOTIFICATION_CREATE"');
const utilityPatch = patches.find(p => value(p, "find")?.text?.includes("NOTIFICATIONS_RECEIVED_RESPONSE"));
assert(utilityPatch);
const utilityPatches = value(utilityPatch, "replacement").elements;
const canonicalize = regex => new RegExp(regex.source.replaceAll(/(\\*)\\i/g, (match, escapes) =>
    escapes.length % 2 ? match.slice(1) : `${escapes}(?:[A-Za-z_$][\\w$]*)`
), regex.flags);
const replace = (text, node) => {
    const match = canonicalize(vm.runInNewContext(value(node, "match").getText(tree)));
    assert(match.test(text), `patch missed: ${match}`);
    return text.replace(match, value(node, "replace").text);
};

// Literal excerpts from Discord's web.d4c7976eccf337f1.js (NotificationStore,
// showNotification, NotificationUtils). Optionally check against a saved complete
// Discord bundle as well: node scripts/testSidebarNotificationRouting.mjs bundle.js
const realBundle = process.argv[2] && readFileSync(process.argv[2], "utf8");
let realPatched;
if (realBundle) {
    // Webpack patches match *factory source*, not the concatenated chunk. The
    // patcher consumes a non-`all` patch on the FIRST factory matching `find`,
    // even when its replacements miss. The old broad IPC-name find matched the
    // earlier constants factory and silently skipped the notification utility.
    const boundaries = [...realBundle.matchAll(/},(\d+)\(e,t,n\)\{/g)];
    const factories = boundaries.map((match, index) => ({
        id: match[1],
        source: realBundle.slice(match.index + match[0].length, boundaries[index + 1]?.index ?? realBundle.length)
    }));
    const getFirstFactory = find => factories.find(factory => factory.source.includes(find));
    const oldBroadMatch = getFirstFactory("NOTIFICATIONS_RECEIVED_RESPONSE");
    assert(oldBroadMatch && !oldBroadMatch.source.includes('l.onclick=e=>'),
        "bundle no longer reproduces the original constants-first patch miss");
    const checkFactory = (find, replacements, marker) => {
        const factory = getFirstFactory(find);
        assert(factory, `no factory contains ${find}`);
        assert(factory.source.includes(marker), `patch ${find} consumed by wrong factory ${factory.id}`);
        let patched = factory.source;
        const stages = [];
        for (const replacement of replacements) {
            patched = replace(patched, replacement);
            stages.push(patched);
        }
        // A valid patch must compile as a Webpack factory, not just parse as a
        // whole chunk after accidentally replacing a different module.
        new vm.Script(`0,function(e,t,n){${patched}}`);
        return stages;
    };
    const [message] = checkFactory('notif_type:"MESSAGE_CREATE",notif_user_id:', [messagePatch], 'clickedNotification()');
    const [wrapper] = checkFactory('type:"NOTIFICATION_CREATE"', [wrapperPatch], 'showNotification(e,t,n,r,a)');
    const utility = checkFactory(value(utilityPatch, "find").text, utilityPatches, 'l.onclick=e=>');
    assert.match(utility[2], /return r\.onClick\?\.\(r\.vcSidebarChatNotificationClick\?e:""\)/);
    realPatched = { message, wrapper, native: utility[0], htmlFocus: utility[1], html: utility[2] };
}
const message = realBundle ?? 'notif_type:"MESSAGE_CREATE",notif_user_id:a.author?.id,channel_id:d.id,guild_id:d.guild_id,{onClick(){(0,D.iN)(d.id),(d.type===ee.rbe.GUILD_VOICE||d.type===ee.rbe.GUILD_STAGE_VOICE)&&c.A.updateChatOpen(d.id,!0),_.default.clickedNotification()},isUserAvatar:!0}';
const wrapper = realBundle ?? 'showNotification(e,t,n,r,a){i.h.dispatch({type:"NOTIFICATION_CREATE",icon:e,title:t,body:n,trackingProps:r,options:{...a,onClick(e){a.onClick?.(e),i.h.dispatch({type:"NOTIFICATION_CLICK"})}}})}';
const native = realBundle ?? 'if(L.isPlatformEmbedded?y.Ay.focus():window.focus(),null!=e){e.options?.onClick?.(i)}';
const html = realBundle ?? 'l.onclick=e=>{L.isPlatformEmbedded?y.Ay.focus():(window.focus(),l.close()),r.omitClickTracking||(C.default.track(D.HAw.NOTIFICATION_ACTION,{action:"CLICK",...i}),C.default.track(D.HAw.NOTIFICATION_CLICKED,p)),r.onClick?.("")}';
const patchedMessage = realPatched?.message ?? replace(message, messagePatch);
const patchedWrapper = realPatched?.wrapper ?? replace(wrapper, wrapperPatch);
const patchedNative = realPatched?.native ?? replace(native, utilityPatches[0]);
const patchedHtmlFocus = realPatched?.htmlFocus ?? replace(html, utilityPatches[1]);
const patchedHtml = realPatched?.html ?? replace(patchedHtmlFocus, utilityPatches[2]);
assert.match(patchedMessage, /routeNotificationClick\(d\.id,d\.guild_id\?\?null/);
assert.match(patchedWrapper, /return i\.h\.dispatch\(\{type:"NOTIFICATION_CLICK"\}\),vcSidebarChatResult/);
assert.match(patchedNative, /shouldDeferNotificationFocus\(e\?\.options\)/);
assert.match(patchedHtml, /return r\.onClick\?\.\(r\.vcSidebarChatNotificationClick\?e:""\)/);
if (realBundle) new vm.Script(patchedHtml);

const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ["getNotificationTargetFocus", "shouldDeferNotificationFocus", "routeNotificationClick"].includes(node.name?.text));
const js = ts.transpileModule(functions.map(node => node.getText(tree)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;
const calls = [];
let result = true;
let pending;
const context = vm.createContext({
    IS_EQUIBOP: true,
    VesktopNative: { win: { focusExistingNotificationTarget: (channel, guild) => {
        calls.push([channel, guild]);
        return pending ?? (result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
    } } },
    window: { focus: () => calls.push("main") }
});
vm.runInContext(`${js}\nthis.helpers={routeNotificationClick,shouldDeferNotificationFocus}`, context);
const { routeNotificationClick, shouldDeferNotificationFocus } = context.helpers;
assert.equal(shouldDeferNotificationFocus({ vcSidebarChatNotificationClick: true }), true);
assert.equal(shouldDeferNotificationFocus({}), false);

const messageOptions = patchedMessage.match(/vcSidebarChatNotificationClick:true,onClick:\$self\.routeNotificationClick\(d\.id,d\.guild_id\?\?null,\(\)=>\{.*?clickedNotification\(\)\}\),isUserAvatar:/)?.[0];
assert(messageOptions);
const makeMessageCallback = (channel, guild) => vm.runInNewContext(`({${messageOptions}true})`, {
    $self: context.helpers,
    d: { id: channel, guild_id: guild, type: "text" },
    D: { iN: () => calls.push("navigation") },
    ee: { rbe: { GUILD_VOICE: "voice", GUILD_STAGE_VOICE: "stage" } },
    c: { A: { updateChatOpen: () => calls.push("voice-open") } },
    _: { default: { clickedNotification: () => calls.push("original") } }
}).onClick;

// Run the exact patched showNotification method body, through the same dispatch
// boundary that the real NOTIFICATION_CREATE event uses.
const wrapperMethod = patchedWrapper.match(/showNotification\(e,t,n,r,a\)\{i\.h\.dispatch\(\{type:"NOTIFICATION_CREATE".*?\}\}\)\}/)?.[0];
assert(wrapperMethod);
let options;
const dispatch = item => {
    if (item.type === "NOTIFICATION_CREATE") options = item.options;
    calls.push(item.type);
};
const notificationFactory = vm.runInNewContext(`({${wrapperMethod}})`, { i: { h: { dispatch } } });
const makeOptions = callback => {
    notificationFactory.showNotification("icon", "title", "body", {}, {
        vcSidebarChatNotificationClick: true,
        onClick: callback
    });
    calls.length = 0;
    return options;
};

// Extract the actual patched HTML onclick assignment, retaining tracking and
// close behavior rather than reconstructing the callback in the test.
const htmlStart = patchedHtml.indexOf("l.onclick=");
const htmlEnd = patchedHtml.indexOf('},M)?', htmlStart);
const htmlClick = patchedHtml.slice(htmlStart, htmlEnd === -1 ? undefined : htmlEnd + 1);
assert(htmlStart !== -1 && htmlClick.endsWith("}"));
let embedded = false;
let receiver;
const htmlWorld = vm.createContext({
    $self: context.helpers,
    L: { get isPlatformEmbedded() { return embedded; } },
    y: { Ay: { focus: () => calls.push("main") } },
    window: { focus: () => calls.push("main") },
    l: { close: () => calls.push("close") },
    C: { default: { track: () => calls.push("track") } },
    D: { HAw: { NOTIFICATION_ACTION: "action", NOTIFICATION_CLICKED: "clicked" } },
    i: {}, p: {}, get r() { return receiver; }
});
vm.runInContext(htmlClick, htmlWorld);

// Mirrors the host's Notification.prototype.onclick setter (renderer/fixes.ts):
// await a returned thenable, then focus main unless the click event was flagged.
const hostClick = event => {
    const focusMainUnlessHandled = () => {
        if (!event.__equibopNotificationTargetHandled) calls.push("host-main");
    };
    const response = htmlWorld.l.onclick(event);
    if (response && typeof response.then === "function") {
        void Promise.resolve(response).then(focusMainUnlessHandled, focusMainUnlessHandled);
    } else focusMainUnlessHandled();
    return response;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const expectedPrefix = (channel, guild, close = true) => [
    ...(close ? ["close"] : []), "track", "track", [channel, guild], "NOTIFICATION_CLICK"
];
for (const [outcome, channel, guild, fallback] of [
    [true, "thread", "guild", false],
    [false, "channel", "guild", true],
    [new Error("host unavailable"), "dm", null, true]
]) {
    result = outcome;
    calls.length = 0;
    receiver = makeOptions(makeMessageCallback(channel, guild));
    const event = {};
    const response = hostClick(event);
    assert.equal(typeof response?.then, "function", "HTML wrapper must return the routing Promise");
    assert.deepEqual(calls, expectedPrefix(channel, guild));
    assert.equal(event.__equibopNotificationTargetHandled, undefined);
    await response;
    await tick();
    assert.equal(event.__equibopNotificationTargetHandled, fallback ? undefined : true);
    assert.deepEqual(calls, [...expectedPrefix(channel, guild), ...(fallback ? ["main", "navigation", "original", "host-main"] : [])]);
}

// An unresolved target must not trigger the host's eager focus before it settles.
calls.length = 0;
pending = new Promise(resolve => { result = resolve; });
receiver = makeOptions(routeNotificationClick("slow", "guild", () => calls.push("original")));
const slowEvent = {};
const slowResponse = hostClick(slowEvent);
assert.deepEqual(calls, expectedPrefix("slow", "guild"));
result(true);
await slowResponse;
await tick();
assert.equal(slowEvent.__equibopNotificationTargetHandled, true);
assert.deepEqual(calls, expectedPrefix("slow", "guild"));
pending = undefined;

// Embedded HTML clicks never closed before; a routed hit must preserve that.
embedded = true;
result = true;
calls.length = 0;
receiver = makeOptions(routeNotificationClick("embedded", null, () => calls.push("original")));
const embeddedEvent = {};
await hostClick(embeddedEvent);
await tick();
assert.deepEqual(calls, expectedPrefix("embedded", null, false));
assert.equal(embeddedEvent.__equibopNotificationTargetHandled, true);
embedded = false;

// Unmarked notifications preserve the empty-string callback argument and old
// window focus + close semantics. No Promise means the host focuses normally.
calls.length = 0;
let ordinaryArgument;
receiver = { onClick: argument => { ordinaryArgument = argument; calls.push("ordinary"); } };
const ordinaryEvent = {};
hostClick(ordinaryEvent);
assert.equal(ordinaryArgument, "");
assert.deepEqual(calls, ["main", "close", "track", "track", "ordinary", "host-main"]);

// Native still skips the utility's eager focus only when routing is available.
const nativeFocus = patchedNative.match(/\(\$self\.shouldDeferNotificationFocus\(e\?\.options\).*?\),null!=e/)?.[0].replace(/,null!=e$/, "");
assert(nativeFocus);
const nativeWorld = { $self: context.helpers, e: { options: { vcSidebarChatNotificationClick: true } },
    L: { isPlatformEmbedded: true }, y: { Ay: { focus: () => calls.push("main") } },
    window: { focus: () => calls.push("main") } };
calls.length = 0;
vm.runInNewContext(nativeFocus, nativeWorld);
assert.deepEqual(calls, []);
await routeNotificationClick("native", null, () => calls.push("original"))();
assert.deepEqual(calls, [["native", null]]);
delete context.VesktopNative.win.focusExistingNotificationTarget;
assert.equal(shouldDeferNotificationFocus({ vcSidebarChatNotificationClick: true }), false);
calls.length = 0;
vm.runInNewContext(nativeFocus, nativeWorld);
assert.deepEqual(calls, ["main"]);
console.log(`SidebarChat notification routing: complete HTML callback chain + native focus passed${realBundle ? " (Discord bundle)" : " (real-bundle excerpts)"}`);
