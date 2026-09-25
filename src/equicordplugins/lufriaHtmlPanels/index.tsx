/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Clickable, MessageStore, useEffect, useState } from "@webpack/common";

import { findPanelAttachment, findPanelFileComponent, matchPanelMarker, MAX_PANEL_BYTES, PANEL_FIRST_CHARACTERS, panelLabel } from "./marker";
import { sanitizePanelHtml } from "./sanitize";

const cl = classNameFactory("vc-lufria-panel-");
const logger = new Logger("LufriaHtmlPanels");

const settings = definePluginSettings({
    autoExpand: {
        type: OptionType.BOOLEAN,
        description: "Expand Lufria panels as soon as they come into view.",
        default: false
    }
});

interface ParserState {
    channelId?: string;
    messageId?: string;
}

interface PanelNode {
    type: "lufriaPanel";
    channelId: string;
    messageId: string;
    label: string;
}

interface TextNode {
    type: "text";
    content: string;
}

export function LufriaPanel({ channelId, messageId, label }: { channelId: string; messageId: string; label: string; }) {
    const [expanded, setExpanded] = useState(settings.plain.autoExpand);
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const message = MessageStore.getMessage(channelId, messageId);
    const attachment = message
        ? findPanelAttachment(message.attachments) ?? findPanelFileComponent(message.components)
        : null;
    const url = attachment?.url;

    useEffect(() => {
        if (!expanded || !attachment || html !== null || error !== null) return;

        if (attachment.size > MAX_PANEL_BYTES) {
            setError(`Panel is larger than ${MAX_PANEL_BYTES / 1024} KiB.`);
            return;
        }

        const controller = new AbortController();

        fetch(attachment.url, { signal: controller.signal })
            .then(res => res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then(body => setHtml(sanitizePanelHtml(body)))
            .catch(e => {
                if (controller.signal.aborted) return;
                logger.warn("Failed to load panel body", e);
                setError("Panel body could not be loaded.");
            });

        return () => controller.abort();
    }, [expanded, url]);

    if (!attachment) return <span className={cl("fallback")}>{label}</span>;

    return (
        <span className={cl("root")}>
            <Clickable
                className={cl("summary")}
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
            >
                <span className={cl("chevron", { open: expanded })}>▸</span>
                <span className={cl("label")}>{label}</span>
            </Clickable>
            {expanded && error !== null ? <span className={cl("error")}>{error}</span> : null}
            {expanded && html !== null
                ? <div className={cl("body")} dangerouslySetInnerHTML={{ __html: html }} />
                : null}
        </span>
    );
}

const PanelBoundary = ErrorBoundary.wrap(LufriaPanel, { noop: true });

export default definePlugin({
    name: "LufriaHtmlPanels",
    description: "Renders Lufria HTML panels inline, from a hidden attachment on the marked message.",
    authors: [{ name: "Lufria", id: 0n }],
    tags: ["Chat"],
    settings,
    patches: [
        {
            find: "roleMention:{order:",
            replacement: {
                match: /roleMention:\{order:(\i\.\i\.order)/,
                replace: "lufriaPanel:$self.getPanelRule($1),$&"
            }
        },
        {
            find: "Unknown markdown rule:",
            replacement: {
                match: /roleMention:\{type:/,
                replace: "lufriaPanel:{type:\"inlineObject\"},$&"
            }
        }
    ],

    getPanelRule(order: number) {
        return {
            order,
            requiredFirstCharacters: PANEL_FIRST_CHARACTERS,
            match: matchPanelMarker,
            parse(capture: RegExpExecArray, _parse: unknown, state: ParserState): PanelNode | TextNode {
                // The chat box and the edit box parse without a message, and there is no panel to
                // resolve there, so the marker stays literal text.
                if (!state.channelId || !state.messageId) return { type: "text", content: capture[0] };

                return {
                    type: "lufriaPanel",
                    channelId: state.channelId,
                    messageId: state.messageId,
                    label: panelLabel(capture)
                };
            },
            react(node: PanelNode) {
                return <PanelBoundary channelId={node.channelId} messageId={node.messageId} label={node.label} />;
            }
        };
    }
});
