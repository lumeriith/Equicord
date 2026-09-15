/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, type IpcMainInvokeEvent, screen } from "electron";

const WINDOW_KEY_PATTERN = /^DISCORD_VC_SC-\d{1,20}$/;
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 100;

export function focusPopout(event: IpcMainInvokeEvent, windowKey: string, title: string): boolean {
    if (
        typeof windowKey !== "string"
        || !WINDOW_KEY_PATTERN.test(windowKey)
        || typeof title !== "string"
        || title.length > 200
    ) return false;

    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const windows = BrowserWindow.getAllWindows().filter(window =>
        window !== senderWindow
        && !window.webContents.isDestroyed()
        && /\/popout(?:[?#]|$)/.test(window.webContents.getURL())
    );
    const minimizedWindows = windows.filter(window => window.isMinimized());
    const window = windows.find(window => window.webContents.mainFrame.name === windowKey)
        ?? windows.find(window => window.getTitle() === title)
        ?? (minimizedWindows.length === 1 ? minimizedWindows[0] : undefined)
        ?? (windows.length === 1 ? windows[0] : undefined);
    if (!window) return false;

    const bounds = window.getBounds();
    const isOnScreen = screen.getAllDisplays().some(({ workArea }) =>
        Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x) >= MIN_VISIBLE_WIDTH
        && Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y) >= MIN_VISIBLE_HEIGHT
    );

    if (!isOnScreen) {
        const targetBounds = screen.getDisplayMatching(senderWindow?.getBounds() ?? bounds).workArea;
        window.setPosition(
            targetBounds.x + Math.max(0, Math.floor((targetBounds.width - bounds.width) / 2)),
            targetBounds.y + Math.max(0, Math.floor((targetBounds.height - bounds.height) / 2))
        );
    }

    if (window.isMinimized()) {
        window.once("restore", () => {
            const wasAlwaysOnTop = window.isAlwaysOnTop();
            if (!wasAlwaysOnTop) window.setAlwaysOnTop(true);
            window.moveTop();
            window.focus();
            if (!wasAlwaysOnTop) window.setAlwaysOnTop(false);
        });
        window.restore();
        window.show();
        window.moveTop();
        window.focus();

        return true;
    }

    const wasAlwaysOnTop = window.isAlwaysOnTop();
    if (!wasAlwaysOnTop) window.setAlwaysOnTop(true);
    if (!window.isVisible()) window.show();
    window.moveTop();
    window.focus();
    if (!wasAlwaysOnTop) window.setAlwaysOnTop(false);

    return true;
}
