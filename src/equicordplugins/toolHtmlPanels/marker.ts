/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PANEL_MARKER = "[tool-panel:v1]";
export const PANEL_ATTACHMENT_NAME = "tool-panel-v1.html";
export const LEGACY_PANEL_MARKER = "[lufria-panel:v1]";
export const LEGACY_PANEL_ATTACHMENT_NAME = "lufria-panel-v1.html";
export const MAX_PANEL_BYTES = 256 * 1024;

/** `[` is the bare marker; `-` is Discord's `-# ` subtext prefix. */
export const PANEL_FIRST_CHARACTERS = ["[", "-"];

/** Only these exact marker/file pairs are supported. Never infer a filename from arbitrary text. */
const FILENAMES: Record<string, string> = {
    [PANEL_MARKER]: PANEL_ATTACHMENT_NAME,
    [LEGACY_PANEL_MARKER]: LEGACY_PANEL_ATTACHMENT_NAME
};

/** A line may be parsed with or without Discord's subtext prefix. */
const PANEL_MARKER_REGEX = /^(?:-#[^\S\n]+)?(\[(?:tool|lufria)-panel:v1\])[^\S\n]*([^\n]*)/;
const LEADING_SEPARATOR_REGEX = /^[·•|:–—-][^\S\n]+/;

function atLineStart(prevCapture: string | undefined | null) {
    return !prevCapture || /\n[^\S\n]*$/.test(prevCapture);
}

/** Discord calls markdown rules as `match(source, state, prevCapture)`. */
export function matchPanelMarker(source: string, _state?: unknown, prevCapture?: string) {
    const capture = PANEL_MARKER_REGEX.exec(source);
    if (capture === null || !Object.hasOwn(FILENAMES, capture[1])) return null;
    if (capture[0][0] === "-" && !atLineStart(prevCapture)) return null;
    return capture;
}

export function panelFilename(capture: RegExpExecArray) {
    return FILENAMES[capture[1]];
}

export function panelLabel(capture: RegExpExecArray) {
    return capture[2].replace(LEADING_SEPARATOR_REGEX, "").trim() || "Tool panel";
}

export interface PanelAttachment {
    filename: string;
    size: number;
    url: string;
}

export function findPanelAttachment<T extends PanelAttachment>(attachments: readonly T[] | undefined, filename: string = PANEL_ATTACHMENT_NAME) {
    return attachments?.find(attachment => attachment.filename === filename) ?? null;
}

/** Components V2 retains uploaded files referenced by a File component. */
export function findPanelFileComponent(components: readonly {
    type: number;
    name?: string;
    size?: number;
    file?: { url?: string; };
}[] | undefined, filename: string = PANEL_ATTACHMENT_NAME): PanelAttachment | null {
    const component = components?.find(item => item.type === 13 && item.name === filename);
    if (typeof component?.size !== "number" || typeof component.file?.url !== "string") return null;
    return { filename, size: component.size, url: component.file.url };
}
