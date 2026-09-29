/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { HeaderBarButton } from "@api/HeaderBar";
import { addSurfacePropsProvider, type SurfaceProvidedProps } from "@api/SurfaceClasses";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { getCurrentChannel } from "@utils/discord";
import definePlugin, { type PluginNative } from "@utils/types";
import { type BrowserWindowFeatures, Channel, Guild, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    extractAndLoadChunksLazy,
    findByPropsLazy,
    findComponentByCodeLazy,
    findCssClassesLazy,
    mapMangledModuleLazy,
} from "@webpack";
import {
    ChannelActionCreators,
    ChannelRouter,
    ChannelSectionStore,
    ChannelStore,
    FluxDispatcher,
    GuildStore,
    Menu,
    MessageActions,
    MessageStore,
    PermissionsBits,
    PermissionStore,
    PopoutActions,
    PopoutWindowStore,
    RelationshipStore,
    SelectedChannelStore,
    SelectedGuildStore,
    showToast,
    Text,
    Toasts,
    useCallback,
    useEffect,
    useLayoutEffect,
    UserStore,
    useState,
    useStateFromStores,
} from "@webpack/common";
import type { MouseEvent as ReactMouseEvent } from "react";

import { getOpenPopoutWindowKeys, getPersistedPopoutChannelIds, getPopoutWindowKey, isPopoutWindowOpen, settings, SidebarStore, syncPersistedPopoutWindows } from "./store";
import style from "./styles.css?managed";

const cl = classNameFactory("vc-sidebar-chat-");
const MIDDLE_CLICK = 1;
const MAXIMIZED_POPOUT_WIDTH = 1200;
const MAXIMIZED_POPOUT_HEIGHT = 700;
const MAXIMIZED_POPOUT_SCREEN_RATIO = 0.8;
const MAXIMIZED_WINDOW_TOLERANCE = 16;
const handledMiddleClicks = new WeakSet<MouseEvent>();
let threadSidebarOwnerWindow: Window | null = null;

const Native = IS_EQUIBOP
    ? VencordNative.pluginHelpers.SidebarChat as PluginNative<typeof import("./native")> | undefined
    : undefined;
const isGuildWindow = IS_EQUIBOP && VesktopNative?.win?.isGuildWindow?.() === true;

// The host implements this as a focus-only lookup: never create a window for a notification.
function getNotificationTargetFocus() {
    if (!IS_EQUIBOP) return;
    return (VesktopNative?.win as typeof VesktopNative.win & {
        focusExistingNotificationTarget?: (channelId: string, guildId: string | null) => Promise<boolean>;
    } | undefined)?.focusExistingNotificationTarget;
}

function shouldDeferNotificationFocus(options?: { vcSidebarChatNotificationClick?: boolean; }) {
    return options?.vcSidebarChatNotificationClick === true && typeof getNotificationTargetFocus() === "function";
}

function routeNotificationClick(channelId: string, guildId: string | null, onClick: () => void) {
    return async (event?: Event) => {
        const focus = getNotificationTargetFocus();
        if (typeof focus === "function") {
            try {
                if (await focus(channelId, guildId)) {
                    if (event && typeof event === "object") Reflect.set(event, "__equibopNotificationTargetHandled", true);
                    return;
                }
            } catch { /* Keep Discord's original click action on host failure. */ }
        }

        // HTML notifications skip the utility's eager main focus while routing is available.
        // For native notifications the host must focus main before reporting a miss.
        window.focus();
        onClick();
    };
}

const HeaderBar = findComponentByCodeLazy("toolbarClassName:", "}),onDoubleClick:");
const ForumView = findComponentByCodeLazy("sidebarState");

const ArrowsLeftRightIcon = ({ color, ...rest }) => {
    return (
        <svg
            aria-hidden="true"
            role="img"
            xmlns="http://www.w3.org/2000/svg"
            fill={color}
            viewBox="0 0 24 24"
            {...rest}>
            <path d="M2.3 7.7a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.4 1.4L5.42 6H21a1 1 0 1 1 0 2H5.41l2.3 2.3a1 1 0 1 1-1.42 1.4l-4-4ZM17.7 21.7l4-4a1 1 0 0 0 0-1.4l-4-4a1 1 0 0 0-1.4 1.4l2.29 2.3H3a1 1 0 1 0 0 2h15.59l-2.3 2.3a1 1 0 0 0 1.42 1.4Z" />
        </svg>
    );
};

const WindowLaunchIcon = findComponentByCodeLazy("1-1h6a1 1 0 1 0 0-2H5Z");
const XSmallIcon = findComponentByCodeLazy("1.4L12 13.42l5.3 5.3Z");
const Chat = findComponentByCodeLazy("filterAfterTimestamp:", "chatInputType");
const SidebarComponents = mapMangledModuleLazy("ChannelChatResizableSidebar", {
    Resize: (value: unknown) => typeof value === "function"
});
const ChannelHeader = findComponentByCodeLazy("`channel-${");
const PopoutWindow = findComponentByCodeLazy("Missing guestWindow reference");
const FullChannelView = findComponentByCodeLazy("showFollowButton:");
const WanderingCubesLoading = findComponentByCodeLazy('="wanderingCubes"');

const ChatInputTypes = findByPropsLazy("FORM", "NORMAL");
const Sidebars = findByPropsLazy("ThreadSidebar", "MessageRequestSidebar");
const ChatClasses = findCssClassesLazy("threadSidebarOpen", "loader");

const requireForumView = extractAndLoadChunksLazy(
    ["Missing channel in Channel.renderHeaderToolbar"],
    /Promise\.all\(\[((?:\i\.e\("\d+"\),?)+)\]\)\.then\(\i\.bind\(\i,(\d+)\)\)[^}]{0,100}?name:"ForumChannel"/
);

function getChannelTitle(channel: Channel | null | undefined) {
    if (!channel) return "Chat";

    if (channel.isPrivate()) {
        const recipientId = channel.getRecipientId?.();
        if (!channel.name && recipientId) {
            const user = UserStore.getUser(recipientId);
            if (user) {
                return RelationshipStore.getNickname(recipientId) || user.globalName || user.username || "DM";
            }
        }

        return channel.name || "DM";
    }

    return channel.name || "Chat";
}

function getPopoutTitle(channel: Channel) {
    const channelTitle = getChannelTitle(channel);
    if (channel.isPrivate()) return channelTitle;

    const guildName = GuildStore.getGuild(channel.guild_id)?.name;
    return guildName ? `${guildName} — ${channelTitle}` : channelTitle;
}

function canOpenPopout(channel: Channel) {
    if (channel.isPrivate()) return true;
    return !channel.isCategory() && !channel.isDirectory();
}

function shouldUseDiscordTitleBar() {
    return IS_EQUIBOP && VesktopNative.settings.get().nativeTitleBar === false;
}

function getPopoutFeatures() {
    const { availWidth, availHeight } = window.screen;
    const mainWindowIsMaximized = window.outerWidth >= availWidth - MAXIMIZED_WINDOW_TOLERANCE
        && window.outerHeight >= availHeight - MAXIMIZED_WINDOW_TOLERANCE;

    const defaultWidth = mainWindowIsMaximized
        ? Math.min(MAXIMIZED_POPOUT_WIDTH, Math.floor(availWidth * MAXIMIZED_POPOUT_SCREEN_RATIO))
        : window.outerWidth;
    const defaultHeight = mainWindowIsMaximized
        ? Math.min(MAXIMIZED_POPOUT_HEIGHT, Math.floor(availHeight * MAXIMIZED_POPOUT_SCREEN_RATIO))
        : window.outerHeight;

    return {
        defaultWidth,
        defaultHeight,
        ...(IS_EQUIBOP && {
            frame: !shouldUseDiscordTitleBar(),
            movable: true,
            resizable: true,
            skipTaskbar: false,
        }),
    } satisfies BrowserWindowFeatures;
}

function getMiddleClickChannel(event: ReactMouseEvent<HTMLElement>) {
    if (!settings.plain.middleClickPopout || event.button !== MIDDLE_CLICK) return null;

    let routeChannelId: string | null = null;
    let listChannelId: string | null = null;

    for (const target of event.nativeEvent.composedPath()) {
        if (!(target instanceof HTMLElement)) continue;

        const listItemId = target.getAttribute("data-list-item-id") ?? target.id;

        if (/^(?:channels___|private-channels-uid___)/.test(listItemId)) {
            listChannelId ??= listItemId.match(/\d+/g)?.at(-1) ?? null;
        }

        if (target instanceof HTMLAnchorElement) {
            const [, channelId] = /^\/channels\/(?:@me|\d+)\/(\d+)\/?$/.exec(target.pathname) ?? [];
            routeChannelId ??= channelId ?? null;
        }
    }

    const channel = ChannelStore.getChannel(routeChannelId ?? listChannelId ?? "");
    if (!channel || !canOpenPopout(channel)) return null;
    if (!listChannelId && !channel.isThread() && !channel.isPrivate()) return null;

    return channel;
}

function consumeMiddleClick(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();

    if (event.type !== "mousedown" || handledMiddleClicks.has(event.nativeEvent)) return false;
    handledMiddleClicks.add(event.nativeEvent);

    return true;
}

function handleChannelMiddleClick(event: ReactMouseEvent<HTMLElement>, channel: Channel | null | undefined) {
    if (!settings.plain.middleClickPopout || event.button !== MIDDLE_CLICK || !channel || !canOpenPopout(channel)) return;

    if (consumeMiddleClick(event)) openOrFocusPopout(channel.id);
}

function handleMiddleClick(event: ReactMouseEvent<HTMLElement>) {
    const channel = getMiddleClickChannel(event);
    if (channel) {
        handleChannelMiddleClick(event, channel);
        return;
    }

    if (event.button !== MIDDLE_CLICK) return;
    const path = event.nativeEvent.composedPath();
    if (!path.some(target => target instanceof HTMLElement && target.getAttribute("data-list-id") === "guildsnav")) return;

    for (const target of path) {
        if (!(target instanceof HTMLElement)) continue;
        const match = /^guildsnav___(\d+)$/.exec(target.getAttribute("data-list-item-id") ?? "");
        if (!match) continue;

        // Discord places unread DM channel icons in the guild rail with the same ID prefix as servers.
        const dm = ChannelStore.getChannel(match[1]);
        if (dm?.isPrivate() && settings.plain.middleClickPopout) {
            handleChannelMiddleClick(event, dm);
            return;
        }

        if (!IS_EQUIBOP || isGuildWindow || !settings.plain.middleClickGuildWindow || !GuildStore.getGuild(match[1])) return;
        const openGuild = VesktopNative?.win?.openOrFocusGuild;
        if (typeof openGuild !== "function") return;
        if (consumeMiddleClick(event)) {
            void openGuild(match[1]).catch(() => showToast("Could not open the server window.", Toasts.Type.FAILURE));
        }
        return;
    }
}

function handleUserMiddleClick(event: ReactMouseEvent<HTMLElement>, userId: string) {
    if (!settings.plain.middleClickPopout || event.button !== MIDDLE_CLICK) return;

    if (consumeMiddleClick(event)) void openOrFocusPopoutFromUser(userId);
}

const middleClickSurfaceProps = {
    onAuxClickCapture: handleMiddleClick,
    onMouseDownCapture: handleMiddleClick,
} satisfies SurfaceProvidedProps;

function provideMiddleClickSurfaceProps() {
    return middleClickSurfaceProps;
}

function getMainChatChannelId() {
    const channelId = SelectedChannelStore.getChannelId();
    const sidebar = ChannelSectionStore.getSidebarState(channelId);
    return sidebar && typeof sidebar === "object" && "channelId" in sidebar && typeof sidebar.channelId === "string"
        ? sidebar.channelId
        : channelId;
}

let restorePersistedPopoutsInterval: number | null = null;
let restoringPersistedPopouts = false;
let removeMiddleClickSurfaceProps: (() => void) | null = null;

function clearPersistedPopoutRestoreLoop() {
    restoringPersistedPopouts = false;
    if (restorePersistedPopoutsInterval !== null) {
        window.clearInterval(restorePersistedPopoutsInterval);
        restorePersistedPopoutsInterval = null;
    }
}

async function waitForChannel(channelId: string, timeoutMs = 2500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const channel = ChannelStore.getChannel(channelId);
        if (channel) return channel;

        await new Promise(resolve => setTimeout(resolve, 80));
    }

    return null;
}

async function waitForDmChannel(userId: string, timeoutMs = 2500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const channelId = ChannelStore.getDMFromUserId?.(userId);
        if (channelId) return channelId;

        await new Promise(resolve => setTimeout(resolve, 80));
    }

    return null;
}

async function resolveDmChannel(userId: string) {
    const existingChannelId = ChannelStore.getDMFromUserId?.(userId);
    if (existingChannelId) return await waitForChannel(existingChannelId);

    try {
        const channelId = await Promise.resolve(ChannelActionCreators.getOrEnsurePrivateChannel(userId));
        if (!channelId) {
            const fallbackChannelId = await waitForDmChannel(userId);
            return fallbackChannelId ? await waitForChannel(fallbackChannelId) : null;
        }

        return await waitForChannel(channelId);
    } catch {
        const fallbackChannelId = await waitForDmChannel(userId);
        return fallbackChannelId ? await waitForChannel(fallbackChannelId) : null;
    }
}

async function openOrFocusPopoutFromUser(userId: string) {
    const channel = await resolveDmChannel(userId);
    if (channel) openOrFocusPopout(channel.id);
}

function closePopout(channelId: string, syncPersistence = true) {
    const windowKey = getPopoutWindowKey(channelId);
    PopoutActions.close(windowKey);
    if (syncPersistence && !restoringPersistedPopouts) {
        syncPersistedPopoutWindows();
    }
}

function showPopout(channel: Channel, syncPersistence = true) {
    const windowKey = getPopoutWindowKey(channel.id);
    const title = getPopoutTitle(channel);

    PopoutActions.open(
        windowKey,
        () => <RenderPopout channel={channel} name={title} windowKey={windowKey} />,
        getPopoutFeatures()
    );

    PopoutActions.setAlwaysOnTop(windowKey, settings.store.popoutAlwaysOnTop);
    if (syncPersistence && !restoringPersistedPopouts) {
        syncPersistedPopoutWindows();
    }
}

function openPopout(channelId: string, syncPersistence = true) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !canOpenPopout(channel)) return;

    if (isPopoutWindowOpen(channelId)) {
        closePopout(channelId, syncPersistence);
        return;
    }

    showPopout(channel, syncPersistence);
}

function focusPopout(channel: Channel) {
    const windowKey = getPopoutWindowKey(channel.id);
    const popoutWindow = PopoutWindowStore.getWindow(windowKey);
    if (!popoutWindow || popoutWindow.closed) return false;

    if (!IS_EQUIBOP) {
        popoutWindow.focus();
        return true;
    }

    if (Native) {
        void Native.focusPopout(windowKey, getPopoutTitle(channel)).then(focused => {
            if (!focused && !popoutWindow.closed) {
                popoutWindow.focus();
                showToast("Could not find the native popout window.", Toasts.Type.FAILURE);
            }
        });
    } else {
        popoutWindow.focus();
    }

    return true;
}

function openOrFocusPopout(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !canOpenPopout(channel)) return;

    if (focusPopout(channel)) return;

    showPopout(channel);
}

function restorePersistedPopouts() {
    if (!settings.store.persistPopoutWindows) return;

    clearPersistedPopoutRestoreLoop();

    const pendingRestoreIds = new Set(getPersistedPopoutChannelIds());
    if (pendingRestoreIds.size === 0) return;

    restoringPersistedPopouts = true;

    const attemptRestore = () => {
        for (const channelId of pendingRestoreIds) {
            const channel = ChannelStore.getChannel(channelId);
            if (!channel || !canOpenPopout(channel)) continue;

            pendingRestoreIds.delete(channelId);
            openPopout(channelId, false);
        }

        if (pendingRestoreIds.size === 0) {
            clearPersistedPopoutRestoreLoop();
            syncPersistedPopoutWindows();
        }
    };

    attemptRestore();

    if (pendingRestoreIds.size > 0) {
        restorePersistedPopoutsInterval = window.setInterval(attemptRestore, 250);
    }
}

const createSidebarChatContextMenuItem = (id: string, guildId: string | null) => {
    return (
        <Menu.MenuItem
            id={`vc-sidebar-chat-${id}`}
            label={"Open Sidebar Chat"}
            action={() => {
                FluxDispatcher.dispatch({
                    // @ts-ignore
                    type: "VC_SIDEBAR_CHAT_NEW",
                    guildId,
                    id,
                });
            }}
        />
    );
};

const UserContextPatch: NavContextMenuPatchCallback = (children, args: { user: User; }) => {
    const checks = [
        args.user,
        args.user.id !== UserStore.getCurrentUser().id,
    ];
    if (checks.some(check => !check)) return;
    children.push(createSidebarChatContextMenuItem(args.user.id, null));
};

const ChannelContextPatch: NavContextMenuPatchCallback = (children, args: { channel: Channel; }) => {
    const checks = [
        args.channel,
        args.channel.type !== ChannelType.GUILD_CATEGORY,
        PermissionStore.can(PermissionsBits.VIEW_CHANNEL, args.channel) || args.channel.type === ChannelType.GROUP_DM,
    ];
    if (checks.some(check => !check)) return;
    children.push(createSidebarChatContextMenuItem(args.channel.id, args.channel.guild_id));
};

export default definePlugin({
    name: "SidebarChat",
    authors: [Devs.Joona, EquicordDevs.justjxke],
    description: "Open a channel or DM as a sidebar or a popout.",
    tags: ["Appearance", "Chat", "Servers"],
    dependencies: ["HeaderBarAPI", "SurfaceClassesAPI"],
    patches: [
        // NotificationStore's MESSAGE_CREATE supplies the actual notified channel (including
        // threads). Preserve Discord's original navigation as the no-match/error fallback.
        {
            find: 'notif_type:"MESSAGE_CREATE",notif_user_id:',
            predicate: () => IS_EQUIBOP,
            replacement: {
                match: /onClick\(\)\{(\(0,\i\.\i\)\((\i)\.id\),\(\2\.type===\i\.\i\.GUILD_VOICE.{0,250}\.clickedNotification\(\))\},isUserAvatar:/,
                replace: "vcSidebarChatNotificationClick:true,onClick:$self.routeNotificationClick($2.id,$2.guild_id??null,()=>{$1}),isUserAvatar:"
            }
        },
        // The showNotification wrapper must forward the channel callback's Promise through
        // its synchronous click-tracking dispatch to the host Notification.onclick handler.
        {
            find: 'type:"NOTIFICATION_CREATE"',
            predicate: () => IS_EQUIBOP,
            replacement: {
                match: /onClick\((\i)\)\{(\i)\.onClick\?\.\(\1\),(\i\.\i\.dispatch\(\{type:"NOTIFICATION_CLICK"\}\))\}/,
                replace: "onClick($1){let vcSidebarChatResult=$2.onClick?.($1);return $3,vcSidebarChatResult}"
            }
        },
        // Discord's notification utility focuses the main window before invoking onClick.
        // Defer that focus for marked message clicks, otherwise it steals focus back from
        // an existing popout/guild window after the host has selected it.
        {
            // The bare IPC name also appears in Discord's earlier constants module.
            // Anchor to the notification utility's listener so this patch is not
            // consumed before its click handlers are defined.
            find: '.on("NOTIFICATIONS_RECEIVED_RESPONSE"',
            predicate: () => IS_EQUIBOP,
            replacement: [
                {
                    match: /(\i\.isPlatformEmbedded\?\i\.\i\.focus\(\):window\.focus\(\)),null!=(\i)/,
                    replace: "($self.shouldDeferNotificationFocus($2?.options)?void 0:$1),null!=$2"
                },
                {
                    match: /((\i)\.isPlatformEmbedded\?\i\.\i\.focus\(\):\(window\.focus\(\),(\i)\.close\(\)\)),(\i)\.omitClickTracking/,
                    replace: "($self.shouldDeferNotificationFocus($4)?($2.isPlatformEmbedded?void 0:$3.close()):$1),$4.omitClickTracking"
                },
                {
                    // The HTML utility passes an empty string rather than its click event.
                    // Forward the event only for routed messages; return the Promise so the
                    // host can wait for the focus-only lookup before deciding to focus main.
                    match: /(\i)\.onclick=(\i)=>\{(.{0,550}?),\s*(\i)\.onClick\?\.\(""\)\}/,
                    replace: '$1.onclick=$2=>{$3;return $4.onClick?.($4.vcSidebarChatNotificationClick?$2:"")}'
                }
            ]
        },
        // The host's Visual Refresh patch can miss the separately loaded guild renderer.
        // Keep Discord's own window controls available only for frameless Equibop windows.
        {
            find: '"refresh-title-bar-small"',
            predicate: () => shouldUseDiscordTitleBar(),
            replacement: [
                {
                    match: /\i===\i\.PlatformTypes\.WINDOWS/g,
                    replace: "true"
                },
                {
                    match: /\i===\i\.PlatformTypes\.WEB/g,
                    replace: "false"
                }
            ]
        },
        // The guild renderer can also miss the host's window-action bridge patch.
        {
            find: ",setSystemTrayApplications",
            predicate: () => isGuildWindow && shouldUseDiscordTitleBar(),
            replacement: {
                match: /\i\.window\.(close|minimize|maximize)/g,
                replace: "VesktopNative.win.$1"
            }
        },
        {
            find: 'case"pendingFriends":',
            group: true,
            replacement: [
                {
                    match: /ChannelRenderer"\),/,
                    replace: "$&vc_SidebarChat=$self.renderSidebar(),"
                },
                {
                    match: /(?<=return )null!=\i&&\i\?\(0,\i\.jsx\)\(\i,\{channel:\i\},\i\.id\):\(0,\i\.jsx\)\(\i,\{\}\)(?=\},)/,
                    replace: "[$&,vc_SidebarChat]"
                },
            ],
        },
        {
            find: "POPOUT)},children:",
            replacement: {
                match: /(?<=getUser\(\i\.ownerId\).{0,100})className:\i\.\i,onClick:function\(\i\)\{\(0,\i\.\i\)\(\i,/,
                replace: "onMouseDownCapture:e=>$self.handleChannelMiddleClick(e,arguments[0].thread),onAuxClickCapture:e=>$self.handleChannelMiddleClick(e,arguments[0].thread),$&"
            }
        },
        {
            find: "ThreadMessageAccessoryMessage",
            replacement: {
                match: /onClick:function\((\i)\)\{\1\.stopPropagation\(\),\(0,\i\.\i\)\((\i),\1\.shiftKey\)\}(?=,onKeyDown:function)/,
                replace: "onClickCapture:e=>$self.setThreadSidebarOwner(e),onMouseDownCapture:e=>$self.handleChannelMiddleClick(e,$2),onAuxClickCapture:e=>$self.handleChannelMiddleClick(e,$2),$&"
            }
        },
        {
            find: "showFollowButton:",
            replacement: {
                match: /(hasModalOpen:\i,section:\i,)channelSidebarState:(\i),guildSidebarState:(\i)(?=,guild:)/,
                replace: "$1channelSidebarState:$self.shouldRenderPopoutThreadSidebar(arguments[0].vcSidebarChatWindowKey,$2)?$2:null,guildSidebarState:$3"
            }
        },
        {
            find: "Missing guestWindow reference",
            predicate: () => IS_EQUIBOP,
            replacement: [
                {
                    match: /(?<=withTitleBar:(\i),isFullScreen:(\i)}=\i;return )\1&&(\i)\.isPlatformEmbedded&&!\2/,
                    replace: "$1&&($3.isPlatformEmbedded||$self.shouldUseDiscordTitleBar())&&!$2"
                },
                {
                    match: /(?<=children:\i=>\(0,\i\.jsx\)\(\i\.cq,\{windowKey:\i,)className:/,
                    replace: "title:this.props.titleBarTitle,$&"
                }
            ]
        },
        {
            find: "PrivateChannel.renderAvatar: Invalid prop configuration - no user or channel",
            replacement: {
                match: /\.CHANNEL\(\i\.\i,\i\.\i\),(?=.{0,150}\.isMultiUserDM\(\))/,
                replace: "$&onMouseDownCapture:e=>$self.handleChannelMiddleClick(e,arguments[0].channel),onAuxClickCapture:e=>$self.handleChannelMiddleClick(e,arguments[0].channel),"
            }
        },
        {
            find: "handleMouseEnter=()=>{let{isFocused:",
            replacement: {
                match: /onContextMenu:(\i)=>this\.handleContextMenu\(\1,(\i)\),onMouseEnter:/g,
                replace: "onMouseDownCapture:e=>$self.handleUserMiddleClick(e,$2.id),onAuxClickCapture:e=>$self.handleUserMiddleClick(e,$2.id),$&"
            }
        },
        {
            find: "handleTextareaChange=",
            replacement: {
                match: /(handleTextareaChange=.{0,200}?if\(\i===\i\.\i\.NORMAL&&)(\i)(!==\i\.\i\.getChannelId\(\))\)return;/,
                replace: "$1$2$3&&!$self.isPopoutWindowOpen($2))return;$self.requestPopoutFrame($2);"
            }
        },
        {
            find: "loadComplete: resetting state for channelId=",
            group: true,
            replacement: [
                {
                    match: /truncateTop\(\i\)\{(?=.{0,100}?this\._array\.length-\i;return)/,
                    replace: "$&if($self.hasMultipleChatViews(this.channelId))return this;"
                },
                {
                    match: /truncateBottom\(\i\)\{(?=.{0,100}?return this\._array\.length<=\i\?this:this\.mutate\()/,
                    replace: "$&if($self.hasMultipleChatViews(this.channelId))return this;"
                }
            ]
        },
    ],
    managedStyle: style,
    settings,
    contextMenus: {
        "user-context": UserContextPatch,
        "channel-context": ChannelContextPatch,
        "thread-context": ChannelContextPatch,
        "gdm-context": ChannelContextPatch,
    },

    toolboxActions: {
        "Open Previous Chat"() {
            FluxDispatcher.dispatch({
                // @ts-ignore
                type: "VC_SIDEBAR_CHAT_PREVIOUS",
            });
        }
    },

    headerBarButton: {
        icon: WindowLaunchIcon,
        render: () => <PopoutPersistenceSync />
    },

    stop() {
        removeMiddleClickSurfaceProps?.();
        removeMiddleClickSurfaceProps = null;
        clearPersistedPopoutRestoreLoop();
        if (!isGuildWindow) syncPersistedPopoutWindows();
        for (const windowKey of getOpenPopoutWindowKeys()) {
            PopoutActions.close(windowKey);
        }
    },

    start() {
        removeMiddleClickSurfaceProps = addSurfacePropsProvider("base", provideMiddleClickSurfaceProps);
        if (!isGuildWindow) restorePersistedPopouts();
    },

    handleChannelMiddleClick(event: ReactMouseEvent<HTMLElement>, channel: Channel) {
        handleChannelMiddleClick(event, channel);
    },

    handleUserMiddleClick(event: ReactMouseEvent<HTMLElement>, userId: string) {
        handleUserMiddleClick(event, userId);
    },

    shouldUseDiscordTitleBar,
    routeNotificationClick,
    shouldDeferNotificationFocus,
    isPopoutWindowOpen,

    requestPopoutFrame(channelId: string) {
        if (isPopoutWindowOpen(channelId)) requestAnimationFrame(() => { });
    },

    setThreadSidebarOwner(event: ReactMouseEvent<HTMLElement>) {
        threadSidebarOwnerWindow = event.currentTarget.ownerDocument.defaultView;
    },

    shouldRenderPopoutThreadSidebar(windowKey: string | undefined, sidebarState: unknown) {
        if (!sidebarState) return true;
        return !windowKey
            || !threadSidebarOwnerWindow
            || threadSidebarOwnerWindow === PopoutWindowStore.getWindow(windowKey);
    },

    hasMultipleChatViews(channelId: string) {
        const mainChannelId = SelectedChannelStore.getChannelId();
        const sidebarHidden = ChannelSectionStore.getSidebarState(mainChannelId)
            || ChannelSectionStore.getGuildSidebarState(SelectedGuildStore.getGuildId() ?? undefined);
        const views = Number(channelId === mainChannelId || channelId === getMainChatChannelId())
            + Number(!sidebarHidden && channelId === SidebarStore.getState().channelId)
            + Number(isPopoutWindowOpen(channelId));
        return views > 1;
    },

    renderSidebar() {
        const { guild, channel /* width*/ } = useStateFromStores(
            [SidebarStore, GuildStore, ChannelStore], () => {
                const { channelId, guildId } = SidebarStore.getState();
                return {
                    guild: GuildStore.getGuild(guildId),
                    channel: ChannelStore.getChannel(channelId)
                };
            }, []
        );

        const [channelSidebar, guildSidebar] = useStateFromStores(
            [ChannelSectionStore, SelectedChannelStore, ChannelStore], () => {
                const currentChannelId = SelectedChannelStore.getChannelId();
                const currentGuildId = SelectedGuildStore.getGuildId()!;
                return [
                    ChannelSectionStore.getSidebarState(currentChannelId),
                    ChannelSectionStore.getGuildSidebarState(currentGuildId),
                ];
            }, []
        );

        useEffect(() => {
            if (!channel?.id || MessageStore.getLastMessage(channel.id)) return;
            MessageActions.fetchMessages({
                channelId: channel.id,
                limit: 50,
            });
        }, [channel?.id]);

        const [width, setWidth] = useState(window.innerWidth);

        useLayoutEffect(() => {
            const handleResize = () => setWidth(window.innerWidth);

            window.addEventListener("resize", handleResize);
            return () => window.removeEventListener("resize", handleResize);
        }, []);

        const [View, setViewComponent] = useState<React.ReactNode>(null);

        useEffect(() => {
            if (!channel) return;

            if (channel.isForumLikeChannel()) {
                requireForumView().then(() => {
                    setViewComponent(
                        <ForumView
                            channel={channel}
                            guild={guild}
                            sidebarState={null}
                        />
                    );
                });

                setViewComponent(
                    <div className={ChatClasses.loader}>
                        <WanderingCubesLoading />
                    </div>
                );
            } else {
                setViewComponent(
                    <Chat
                        channel={channel}
                        guild={guild}
                        chatInputType={ChatInputTypes.SIDEBAR}
                    />
                );
            }
        }, [channel]);

        if (!channel || channelSidebar || guildSidebar) return null;

        return (
            <ErrorBoundary noop>
                <SidebarComponents.Resize
                    sidebarType={Sidebars.MessageRequestSidebar}
                    maxWidth={~~(width * 0.31)/* width - 690*/}
                >
                    <Header channel={channel} guild={guild} />
                    {View}
                </SidebarComponents.Resize>
            </ErrorBoundary>
        );
    },
});

const Header = ({ guild, channel }: { guild: Guild; channel: Channel; }) => {
    const recipientId = channel.isPrivate() ? channel.getRecipientId() as string : null;

    const name = useStateFromStores([UserStore, RelationshipStore], () => getChannelTitle(channel), [channel.id, channel.name]);

    const parentChannel = useStateFromStores(
        [ChannelStore], () => ChannelStore.getChannel(channel?.parent_id),
        [channel?.parent_id]
    );

    const closeSidebar = () => FluxDispatcher.dispatch({ type: "VC_SIDEBAR_CHAT_CLOSE", });

    const switchChannels = useCallback(() => {
        const mainChannel = getCurrentChannel()!;
        FluxDispatcher.dispatch({
            // @ts-ignore
            type: "VC_SIDEBAR_CHAT_NEW",
            guildId: mainChannel.guild_id,
            id: mainChannel.id,
        });
        ChannelRouter.transitionToChannel(channel.id);
    }, [channel.id]);

    return (
        <HeaderBar
            toolbar={
                <>
                    <HeaderBarButton icon={ArrowsLeftRightIcon} tooltip="Switch channels" onClick={switchChannels} />
                    <HeaderBarButton icon={XSmallIcon} tooltip="Close Sidebar Chat" onClick={closeSidebar} />
                </>
            }
        >
            <ChannelHeader
                channel={channel}
                channelName={name}
                guild={guild}
                parentChannel={parentChannel}
            />
        </HeaderBar>
    );
};

const RenderPopout = ErrorBoundary.wrap(({ channel, name, windowKey }: { channel: Channel; name: string; windowKey: string; }) => {
    // Copy from an unexported function of the one they use in the experiment
    // right click a channel and search withTitleBar:!0,windowKey
    useEffect(() => {
        if (IS_EQUIBOP) void Native?.focusPopout(windowKey, name);
    }, [name, windowKey]);

    useEffect(() => {
        if (!channel?.id || MessageStore.getLastMessage(channel.id)) return;

        MessageActions.fetchMessages({
            channelId: channel.id,
            limit: 50,
        });
    }, [channel?.id]);

    return (
        <PopoutWindow
            withTitleBar={!IS_EQUIBOP || shouldUseDiscordTitleBar()}
            windowKey={windowKey}
            title={name || "Equicord"}
            titleBarTitle={
                <Text className={cl("title")} variant="text-sm/medium" color="text-default">
                    {name}
                </Text>
            }
            channelId={channel.id}
            keybinds={[{
                action: () => closePopout(channel.id),
                binds: ["mod+w"],
                comboKeysBindGlobal: true,
            }]}
        >
            <div className={cl("window")}>
                {channel.isGuildVocal()
                    ? <Chat channel={channel} guild={GuildStore.getGuild(channel.guild_id)} chatInputType={ChatInputTypes.NORMAL} />
                    : <FullChannelView providedChannel={channel} vcSidebarChatWindowKey={windowKey} />}
            </div>
        </PopoutWindow>
    );
});

function PopoutPersistenceSync() {
    const openWindowKeySignature = useStateFromStores(
        [PopoutWindowStore],
        () => getOpenPopoutWindowKeys().join("|"),
        []
    );

    useEffect(() => {
        if (isGuildWindow || restoringPersistedPopouts) return;
        syncPersistedPopoutWindows();
    }, [openWindowKeySignature]);

    return null;
}
