/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PANEL_MARKER = "[lufria-panel:v1]";
export const PANEL_ATTACHMENT_NAME = "lufria-panel-v1.html";
export const MAX_PANEL_BYTES = 256 * 1024;

/**
 * Characters the markdown rule must be offered, so Discord's `requiredFirstCharacters`
 * optimisation does not skip us. `[` is the bare marker; `-` is the `-# ` subtext prefix
 * the gateway wraps the fallback line in.
 */
export const PANEL_FIRST_CHARACTERS = ["[", "-"];

/**
 * The wire format is one line:
 *
 *     -# [lufria-panel:v1] · +12 earlier · read foo.py · edit bar.py
 *
 * `-# ` is Discord subtext. Whether this rule ever sees it depends on where the line is
 * parsed: in a block context Discord's own subtext rule consumes `-# ` first and hands us
 * only the remainder, while an inline-only parse leaves it in the source. Both are matched
 * here so the whole line is consumed either way and nothing of it survives as literal text.
 *
 * The separator between the marker and the summary is deliberately loose — the gateway
 * joins steps with " · ", but the exact glue after the marker is not part of the contract.
 */
const PANEL_MARKER_REGEX = /^(?:-#[^\S\n]+)?\[lufria-panel:v1\][^\S\n]*([^\n]*)/;

/** A separator immediately after the marker is glue, not part of the human-readable label. */
const LEADING_SEPARATOR_REGEX = /^[·•|:–—-][^\S\n]+/;

/** `-# ` is only Discord subtext at the start of a line, never mid-sentence. */
function atLineStart(prevCapture: string | undefined | null) {
    return !prevCapture || /\n[^\S\n]*$/.test(prevCapture);
}

/**
 * Discord calls markdown rules as `match(source, state, prevCapture)`. `prevCapture` is
 * optional here so the matcher stays directly testable.
 */
export function matchPanelMarker(source: string, _state?: unknown, prevCapture?: string) {
    const capture = PANEL_MARKER_REGEX.exec(source);
    if (capture === null) return null;

    if (capture[0][0] === "-" && !atLineStart(prevCapture)) return null;

    return capture;
}

export function panelLabel(capture: RegExpExecArray) {
    return capture[1].replace(LEADING_SEPARATOR_REGEX, "").trim() || "Lufria panel";
}

export interface PanelAttachment {
    filename: string;
    size: number;
    url: string;
}

export function findPanelAttachment<T extends PanelAttachment>(attachments: readonly T[]) {
    return attachments.find(attachment => attachment.filename === PANEL_ATTACHMENT_NAME) ?? null;
}

/** Components V2 only retains uploaded files referenced by a File component. */
export function findPanelFileComponent(components: readonly {
    type: number;
    name?: string;
    size?: number;
    file?: { url?: string; };
}[] | undefined): PanelAttachment | null {
    const component = components?.find(item => item.type === 13 && item.name === PANEL_ATTACHMENT_NAME);
    if (typeof component?.size !== "number" || typeof component.file?.url !== "string") return null;
    return { filename: PANEL_ATTACHMENT_NAME, size: component.size, url: component.file.url };
}
