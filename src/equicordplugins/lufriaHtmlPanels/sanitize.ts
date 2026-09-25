/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
    "a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "details", "div", "dl", "dt",
    "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "kbd", "li",
    "mark", "ol", "p", "pre", "s", "samp", "small", "span", "strong", "sub", "summary", "sup",
    "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var"
];

const ALLOWED_ATTR = [
    "colspan", "datetime", "dir", "href", "lang", "reversed", "rowspan", "scope", "start", "style", "title"
];

// url()/image-set() pull in subresources, @import pulls in stylesheets, and fixed/sticky
// positioning lets a panel escape its container and cover Discord's own UI.
const UNSAFE_STYLE = /url\(|image-set\(|expression\(|@import|position\s*:\s*(?:fixed|sticky)/i;

const purifier = DOMPurify(window);

purifier.addHook("afterSanitizeAttributes", node => {
    const style = node.getAttribute("style");
    if (style && UNSAFE_STYLE.test(style)) node.removeAttribute("style");

    if (node.tagName === "A" && node.hasAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    }
});

export function sanitizePanelHtml(html: string) {
    return purifier.sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^https?:\/\//i
    });
}
