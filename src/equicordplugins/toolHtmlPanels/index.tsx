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

import { findPanelAttachment, findPanelFileComponent, matchPanelMarker, MAX_PANEL_BYTES, PANEL_FIRST_CHARACTERS, panelFilename, panelLabel } from "./marker";
import { sanitizePanelHtml } from "./sanitize";

const cl = classNameFactory("vc-tool-panel-");
const logger = new Logger("ToolHtmlPanels");

const settings = definePluginSettings({
    autoExpand: {
        type: OptionType.BOOLEAN,
        description: "Expand tool panels as soon as they come into view.",
        default: false
    }
});

interface ParserState {
    channelId?: string;
    messageId?: string;
}

interface PanelNode {
    type: "toolPanel";
    channelId: string;
    messageId: string;
    label: string;
    filename: string;
}

interface TextNode {
    type: "text";
    content: string;
}

export function ToolPanel({ channelId, messageId, label, filename }: { channelId: string; messageId: string; label: string; filename: string; }) {
    const [expanded, setExpanded] = useState(settings.plain.autoExpand);
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const message = MessageStore.getMessage(channelId, messageId);
    const attachment = message
        ? findPanelAttachment(message.attachments, filename) ?? findPanelFileComponent(message.components, filename)
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
        <span className={cl("root")} data-panel-file={filename}>
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

const PanelBoundary = ErrorBoundary.wrap(ToolPanel, { noop: true });

export default definePlugin({
    name: "ToolHtmlPanels",
    description: "Renders marked tool HTML panels inline from matching message attachments.",
    authors: [{ name: "Tool Panels Contributors", id: 0n }],
    tags: ["Chat"],
    settings,
    patches: [
        {
            find: "roleMention:{order:",
            replacement: {
                match: /roleMention:\{order:(\i\.\i\.order)/,
                replace: "toolPanel:$self.getPanelRule($1),$&"
            }
        },
        {
            find: "Unknown markdown rule:",
            replacement: {
                match: /roleMention:\{type:/,
                replace: "toolPanel:{type:\"inlineObject\"},$&"
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

                const filename = panelFilename(capture);
                const message = MessageStore.getMessage(state.channelId, state.messageId);
                // Do not consume an unrelated or malformed message: both halves of the exact
                // protocol pair must exist on this same message before replacing its text.
                if (!message || !(findPanelAttachment(message.attachments, filename) ?? findPanelFileComponent(message.components, filename))) {
                    return { type: "text", content: capture[0] };
                }

                return {
                    type: "toolPanel",
                    channelId: state.channelId,
                    messageId: state.messageId,
                    label: panelLabel(capture),
                    filename
                };
            },
            react(node: PanelNode) {
                return <PanelBoundary channelId={node.channelId} messageId={node.messageId} label={node.label} filename={node.filename} />;
            }
        };
    }
});
