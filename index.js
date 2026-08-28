(() => {
    const PLUGIN_NAME = "SDM Bulk";
    const MAX_TARGETS = 100;

    let unregisterBulk = null;
    let unregisterClear = null;
    let unregisterRoleSwap = null;
    let unregisterClearRoleSwap = null;
    let unpatchCosmeticSend = null;
    let unpatchRoleReadLayer = null;

    const storage = (() => {
        try {
            const created = vendetta?.plugin?.createStorage?.();
            if (created && typeof created === "object") return created;
        } catch {}

        try {
            const legacy = vendetta?.plugin?.storage;
            if (legacy && typeof legacy === "object") return legacy;
        } catch {}

        return {};
    })();

    if (!Array.isArray(storage.spoofDMs)) storage.spoofDMs = [];
    if (!Array.isArray(storage.roleSwaps)) storage.roleSwaps = [];

    function getArg(args, name) {
        const item = Array.isArray(args) ? args.find(x => x?.name === name) : null;
        return item?.value ?? "";
    }

    function parseIds(input) {
        const ids = [];
        const seen = new Set();

        for (const token of String(input ?? "").split(/[\s,;]+/g)) {
            const match = token.match(/\d{17,20}/);
            if (!match) continue;
            const id = match[0];
            if (!seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        }
        return ids;
    }

    function toast(message) {
        try {
            const t = vendetta?.ui?.toasts;
            const a = vendetta?.ui?.assets;
            if (t?.showToast) {
                const icon =
                    a?.getAssetIDByName?.("ic_message") ??
                    a?.getAssetIDByName?.("Small");
                t.showToast(String(message), icon);
                return;
            }
        } catch {}
        try { vendetta?.logger?.log?.(`[${PLUGIN_NAME}] ${message}`); } catch {}
    }

    function modules() {
        const metro = vendetta?.metro;
        if (!metro?.findByProps) throw new Error("Kettu Metro API unavailable.");

        const Dispatcher = metro.findByProps("dispatch", "subscribe");
        const UserStore = metro.findByProps("getUser", "getCurrentUser");
        const ChannelStore =
            metro.findByProps("getDMChannelFromUserId", "getDMFromUserId") ||
            metro.findByProps("getChannel", "getDMFromUserId");

        const ChannelActionCreators =
            metro.findByProps("openPrivateChannel", "ensurePrivateChannel") ||
            metro.findByProps("ensurePrivateChannel") ||
            metro.findByProps("openPrivateChannel");

        if (!Dispatcher?.dispatch) throw new Error("Could not find Flux dispatcher.");
        if (!UserStore?.getUser) throw new Error("Could not find UserStore.");
        if (!ChannelStore?.getDMFromUserId) throw new Error("Could not find ChannelStore.");
        if (
            !ChannelActionCreators?.ensurePrivateChannel &&
            !ChannelActionCreators?.openPrivateChannel
        ) {
            throw new Error("Could not find Discord private-channel action.");
        }

        return {
            Dispatcher,
            UserStore,
            ChannelStore,
            ChannelActionCreators
        };
    }

    function fakeSnowflakeFromTimestamp(timestampMs, offset = 0) {
        const EPOCH = 1420070400000n;
        const safeMs = Math.max(Number(timestampMs) + offset, Number(EPOCH) + 1);
        const ms = BigInt(Math.floor(safeMs));
        const rand = BigInt(Math.floor(Math.random() * 4194303));
        return String(((ms - EPOCH) << 22n) | rand);
    }

    function fallbackUser(id) {
        return {
            id,
            username: `User ${id.slice(-4)}`,
            global_name: null,
            discriminator: "0",
            avatar: null,
            bot: false,
            system: false,
            public_flags: 0
        };
    }

    function parseTimestamp(dateInput, timeInput) {
        const date = String(dateInput ?? "").trim();
        const time = String(timeInput ?? "").trim();

        if (!date && !time) return new Date();

        const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (date && !dateMatch) {
            throw new Error("Date must be YYYY-MM-DD.");
        }

        const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (time && !timeMatch) {
            throw new Error("Time must be HH:MM or HH:MM:SS.");
        }

        const now = new Date();

        const year = dateMatch ? Number(dateMatch[1]) : now.getFullYear();
        const month = dateMatch ? Number(dateMatch[2]) - 1 : now.getMonth();
        const day = dateMatch ? Number(dateMatch[3]) : now.getDate();

        const hour = timeMatch ? Number(timeMatch[1]) : now.getHours();
        const minute = timeMatch ? Number(timeMatch[2]) : now.getMinutes();
        const second = timeMatch && timeMatch[3] ? Number(timeMatch[3]) : 0;

        if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
            throw new Error("Invalid time.");
        }

        const result = new Date(year, month, day, hour, minute, second, 0);

        if (
            result.getFullYear() !== year ||
            result.getMonth() !== month ||
            result.getDate() !== day
        ) {
            throw new Error("Invalid calendar date.");
        }

        return result;
    }

    function buildDmChannel(user, channelId, lastMessageId) {
        return {
            id: channelId,
            type: 1,
            flags: 0,
            recipients: [user],
            recipient_ids: [user.id],
            last_message_id: lastMessageId,
            is_spam: false,
            owner_id: null,
            name: null,
            icon: null
        };
    }

    function installIntoMutablePrivateChannels(ChannelStore, channel) {
        // Crash-safe: never mutate Discord internal channel collections directly.
        return false;
    }

    function createLocalDm(Dispatcher, ChannelStore, user, channelId, lastMessageId) {
        const channel = buildDmChannel(user, channelId, lastMessageId);

        const inserted = installIntoMutablePrivateChannels(ChannelStore, channel);

        // Tell Flux stores/components that a new private channel exists.
        Dispatcher.dispatch({
            type: "CHANNEL_CREATE",
            channel
        });

        return inserted;
    }

    function dispatchFakeIncoming(Dispatcher, record) {
        Dispatcher.dispatch({
            type: "MESSAGE_CREATE",
            message: {
                id: record.messageId,
                type: 0,
                channel_id: record.channelId,
                author: record.user,
                content: record.content,
                timestamp: record.timestamp,
                edited_timestamp: null,
                tts: false,
                mention_everyone: false,
                mentions: [],
                mention_roles: [],
                mention_channels: [],
                attachments: [],
                embeds: [],
                reactions: [],
                pinned: false,
                flags: 0,
                components: [],
                sticker_items: []
            },
            channelId: record.channelId,
            optimistic: false
        });
    }

    function replayRecord(record) {
        const { Dispatcher, ChannelStore } = modules();
        createLocalDm(Dispatcher, ChannelStore, record.user, record.channelId, record.messageId);
        dispatchFakeIncoming(Dispatcher, record);
    }

    function saveRecord(record) {
        const existing = storage.spoofDMs.findIndex(x => x.userId === record.userId);
        if (existing >= 0) storage.spoofDMs[existing] = record;
        else storage.spoofDMs.push(record);
    }




    function formatError(err) {
        try {
            if (err == null) return "unknown failure";
            if (typeof err === "string") return err;

            const parts = [];

            if (err?.name) parts.push(`name=${err.name}`);
            if (err?.message) parts.push(`message=${err.message}`);
            if (err?.code !== undefined) parts.push(`code=${err.code}`);
            if (err?.status !== undefined) parts.push(`status=${err.status}`);

            const response =
                err?.response ??
                err?.body ??
                err?.data ??
                err?.raw ??
                null;

            if (response !== null && response !== undefined) {
                try {
                    parts.push(
                        `response=${
                            typeof response === "string"
                                ? response
                                : JSON.stringify(response)
                        }`
                    );
                } catch {}
            }

            if (!parts.length) {
                try {
                    return JSON.stringify(err);
                } catch {
                    return String(err);
                }
            }

            return parts.join(" | ");
        } catch {
            try { return String(err); } catch {}
            return "unknown failure";
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getDmChannelId(ChannelStore, userId) {
        try {
            const id = ChannelStore.getDMFromUserId(userId);
            if (typeof id === "string") return id;
            if (id?.id) return id.id;
        } catch {}

        try {
            const channel = ChannelStore.getDMChannelFromUserId?.(userId);
            if (channel?.id) return channel.id;
        } catch {}

        return null;
    }

    async function waitForDmChannel(ChannelStore, userId, timeoutMs = 5000) {
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
            const id = getDmChannelId(ChannelStore, userId);
            if (id) return id;
            await sleep(100);
        }

        return null;
    }

    
    function stageError(stage, err) {
        const detail = formatError(err);
        const wrapped = new Error(`${stage}: ${detail}`);
        try {
            wrapped.stage = stage;
            wrapped.original = err;
        } catch {}
        return wrapped;
    }

async function openRealDm(ChannelActionCreators, ChannelStore, UserStore, userId) {
        const existing = getDmChannelId(ChannelStore, userId);
        if (existing) return existing;

        const currentUserId = (() => {
            try { return UserStore.getCurrentUser()?.id ?? null; } catch { return null; }
        })();

        // Preferred path: ensure/create the DM without selecting/navigating to it.
        if (ChannelActionCreators?.ensurePrivateChannel) {
            let result;

            try {
                // Older/current Discord client builds commonly use
                // ensurePrivateChannel(currentUserId, recipientId).
                if (currentUserId) {
                    result = ChannelActionCreators.ensurePrivateChannel(
                        currentUserId,
                        userId
                    );
                } else {
                    result = ChannelActionCreators.ensurePrivateChannel(userId);
                }
            } catch (firstError) {
                // Some builds use an object argument instead.
                try {
                    result = ChannelActionCreators.ensurePrivateChannel({
                        recipientIds: [userId]
                    });
                } catch {
                    throw firstError;
                }
            }

            if (result && typeof result.then === "function") {
                try {
                    const resolved = await result;
                    const directId =
                        typeof resolved === "string" ? resolved :
                        resolved?.id ??
                        resolved?.channel?.id ??
                        resolved?.channelId;

                    if (directId) return String(directId);
                } catch (err) {
                    throw new Error(
                        `Discord could not ensure DM: ${err?.message || String(err)}`
                    );
                }
            } else {
                const directId =
                    typeof result === "string" ? result :
                    result?.id ??
                    result?.channel?.id ??
                    result?.channelId;

                if (directId) return String(directId);
            }

            const ensuredId = await waitForDmChannel(ChannelStore, userId, 5000);
            if (ensuredId) return ensuredId;
        }

        // Fallback only: some Kettu/Discord builds may expose openPrivateChannel
        // but not ensurePrivateChannel. This can select the DM visually.
        if (!ChannelActionCreators?.openPrivateChannel) {
            throw new Error("No usable private-channel opener exists.");
        }

        let result;

        try {
            result = ChannelActionCreators.openPrivateChannel({
                recipientIds: [userId]
            });
        } catch (firstError) {
            try {
                result = ChannelActionCreators.openPrivateChannel(userId);
            } catch {
                throw firstError;
            }
        }

        if (result && typeof result.then === "function") {
            try {
                const resolved = await result;
                const directId =
                    typeof resolved === "string" ? resolved :
                    resolved?.id ??
                    resolved?.channel?.id ??
                    resolved?.channelId;

                if (directId) return String(directId);
            } catch (err) {
                throw new Error(
                    `Discord could not open DM: ${err?.message || String(err)}`
                );
            }
        } else {
            const directId =
                typeof result === "string" ? result :
                result?.id ??
                result?.channel?.id ??
                result?.channelId;

            if (directId) return String(directId);
        }

        const channelId = await waitForDmChannel(ChannelStore, userId, 5000);
        if (!channelId) {
            throw new Error("DM channel did not appear in ChannelStore.");
        }

        return channelId;
    }


    function getGuildIdFromChannel(ChannelStore, channelId) {
        try {
            const channel = ChannelStore.getChannel?.(channelId);
            return channel?.guild_id ?? channel?.guildId ?? null;
        } catch {
            return null;
        }
    }

    function isCosmeticChatActiveForGuild(guildId) {
        if (!guildId) return false;
        return storage.roleSwaps.some(record => record?.guildId === guildId);
    }

    function dispatchOwnLocalMessage(Dispatcher, UserStore, channelId, content) {
        const me = UserStore.getCurrentUser?.();
        if (!me) throw new Error("Current user unavailable.");

        const now = Date.now();
        const id = fakeSnowflakeFromTimestamp(
            now,
            Math.floor(Math.random() * 1000)
        );

        Dispatcher.dispatch({
            type: "MESSAGE_CREATE",
            message: {
                id,
                type: 0,
                channel_id: channelId,
                author: me,
                content: String(content ?? ""),
                timestamp: new Date(now).toISOString(),
                edited_timestamp: null,
                tts: false,
                mention_everyone: false,
                mentions: [],
                mention_roles: [],
                mention_channels: [],
                attachments: [],
                embeds: [],
                reactions: [],
                pinned: false,
                flags: 0,
                components: [],
                sticker_items: []
            },
            channelId,
            optimistic: false
        });

        return id;
    }

    function installCosmeticSendInterceptor() {
        const metro = vendetta?.metro;
        const patcher = vendetta?.patcher;

        if (!metro?.findByProps || !patcher?.instead) {
            throw new Error("Kettu patcher API unavailable.");
        }

        const MessageActions =
            metro.findByProps("sendMessage", "editMessage") ||
            metro.findByProps("sendMessage");

        const Dispatcher = metro.findByProps("dispatch", "subscribe");
        const UserStore = metro.findByProps("getUser", "getCurrentUser");
        const ChannelStore =
            metro.findByProps("getChannel", "getDMFromUserId") ||
            metro.findByProps("getChannel");

        if (!MessageActions?.sendMessage) {
            throw new Error("Could not find sendMessage.");
        }

        return patcher.instead(
            "sendMessage",
            MessageActions,
            (args, original) => {
                try {
                    const channelId = String(args?.[0] ?? "");
                    const guildId = getGuildIdFromChannel(
                        ChannelStore,
                        channelId
                    );

                    // Only intercept normal channel sends inside servers where
                    // a local /role-swap is active. DMs and other servers send normally.
                    if (!isCosmeticChatActiveForGuild(guildId)) {
                        return original(...args);
                    }

                    const payload = args?.[1] ?? {};
                    const content =
                        typeof payload === "string"
                            ? payload
                            : payload?.content ?? "";

                    if (!String(content).trim()) {
                        toast("Cosmetic Chat: text only.");
                        return Promise.resolve({
                            local: true,
                            blockedFromServer: true
                        });
                    }

                    dispatchOwnLocalMessage(
                        Dispatcher,
                        UserStore,
                        channelId,
                        content
                    );

                    // Critical: never call original sendMessage in cosmetic mode.
                    return Promise.resolve({
                        local: true,
                        blockedFromServer: true
                    });
                } catch (err) {
                    try {
                        vendetta?.logger?.error?.(
                            `[${PLUGIN_NAME}] cosmetic-send`,
                            err
                        );
                    } catch {}

                    // Fail closed: an interceptor error must never leak the message
                    // to Discord's real send path.
                    toast("Cosmetic Chat error: message stayed local.");
                    return Promise.resolve({
                        local: true,
                        blockedFromServer: true,
                        error: true
                    });
                }
            }
        );
    }


    function getActiveRoleSwap(guildId, userId) {
        if (!guildId || !userId) return null;
        return storage.roleSwaps.find(
            record =>
                String(record?.guildId) === String(guildId) &&
                String(record?.myUserId) === String(userId)
        ) ?? null;
    }

    function mergeSpoofedMember(realMember, record) {
        if (!record || !realMember) return realMember;

        const spoofed = record.spoofed ?? {};
        const joined =
            spoofed.joined_at ??
            spoofed.joinedAt ??
            realMember.joined_at ??
            realMember.joinedAt ??
            null;

        const colorRoleId =
            spoofed.colorRoleId ??
            spoofed.color_role_id ??
            realMember.colorRoleId ??
            realMember.color_role_id ??
            null;

        const hoistRoleId =
            spoofed.hoistRoleId ??
            spoofed.hoist_role_id ??
            realMember.hoistRoleId ??
            realMember.hoist_role_id ??
            null;

        return {
            ...realMember,
            roles: Array.isArray(spoofed.roles)
                ? [...spoofed.roles]
                : Array.isArray(realMember.roles)
                    ? [...realMember.roles]
                    : [],
            joined_at: joined,
            joinedAt: joined,

            // Role presentation metadata used by different Discord/Kettu builds.
            colorRoleId,
            color_role_id: colorRoleId,
            hoistRoleId,
            hoist_role_id: hoistRoleId,
            color: spoofed.color ?? realMember.color ?? 0,
            colorString:
                spoofed.colorString ??
                spoofed.color_string ??
                realMember.colorString ??
                realMember.color_string ??
                null,
            color_string:
                spoofed.colorString ??
                spoofed.color_string ??
                realMember.color_string ??
                realMember.colorString ??
                null
        };
    }

    function installRoleReadLayer() {
        const metro = vendetta?.metro;
        const patcher = vendetta?.patcher;

        if (!metro?.findByProps || !patcher?.after) {
            throw new Error("Kettu patcher API unavailable.");
        }

        const GuildMemberStore =
            metro.findByProps("getMember", "getMembers") ||
            metro.findByProps("getMember");

        const UserStore = metro.findByProps("getUser", "getCurrentUser");

        if (!GuildMemberStore?.getMember) {
            throw new Error("Could not find GuildMemberStore.");
        }

        const unpatches = [];

        const addAfter = (name, callback) => {
            try {
                if (typeof GuildMemberStore?.[name] === "function") {
                    const unpatch = patcher.after(
                        name,
                        GuildMemberStore,
                        callback
                    );
                    if (typeof unpatch === "function") {
                        unpatches.push(unpatch);
                    }
                }
            } catch {}
        };

        // Most profile/member displays use this.
        addAfter("getMember", (args, result) => {
            const guildId = String(args?.[0] ?? "");
            const userId = String(args?.[1] ?? "");
            const record = getActiveRoleSwap(guildId, userId);
            return mergeSpoofedMember(result, record);
        });

        // Some profile surfaces deliberately bypass getMember.
        addAfter("getTrueMember", (args, result) => {
            const guildId = String(args?.[0] ?? "");
            const userId = String(args?.[1] ?? "");
            const record = getActiveRoleSwap(guildId, userId);
            return mergeSpoofedMember(result, record);
        });

        // Current-user profile surfaces can use dedicated self getters.
        const patchSelfMember = (name) => {
            addAfter(name, (args, result) => {
                const guildId = String(args?.[0] ?? "");
                let userId = "";
                try {
                    userId = String(UserStore?.getCurrentUser?.()?.id ?? "");
                } catch {}
                const record = getActiveRoleSwap(guildId, userId);
                return mergeSpoofedMember(result, record);
            });
        };

        patchSelfMember("getSelfMember");
        patchSelfMember("getCachedSelfMember");

        // Member list / hierarchy code can use the pending-role getter directly
        // instead of reading member.roles.
        addAfter("getMemberRoleWithPendingUpdates", (args, result) => {
            const guildId = String(args?.[0] ?? "");
            const userId = String(args?.[1] ?? "");
            const record = getActiveRoleSwap(guildId, userId);

            if (!record) return result;

            return Array.isArray(record?.spoofed?.roles)
                ? [...record.spoofed.roles]
                : result;
        });

        // Some member-list calculations operate over getMembers(guildId).
        addAfter("getMembers", (args, result) => {
            const guildId = String(args?.[0] ?? "");
            if (!Array.isArray(result)) return result;

            return result.map(member => {
                const userId = String(
                    member?.userId ??
                    member?.user?.id ??
                    member?.user_id ??
                    ""
                );

                const record = getActiveRoleSwap(guildId, userId);
                return record ? mergeSpoofedMember(member, record) : member;
            });
        });

        // Join date shown in the self profile can come from this direct getter.
        addAfter("getSelfMemberJoinedAt", (args, result) => {
            const guildId = String(args?.[0] ?? "");
            let userId = "";
            try {
                userId = String(UserStore?.getCurrentUser?.()?.id ?? "");
            } catch {}

            const record = getActiveRoleSwap(guildId, userId);
            if (!record) return result;

            const joined =
                record?.spoofed?.joined_at ??
                record?.spoofed?.joinedAt;

            if (!joined) return result;

            try {
                return new Date(joined);
            } catch {
                return result;
            }
        });

        return () => {
            for (const unpatch of unpatches.reverse()) {
                try { unpatch(); } catch {}
            }
        };
    }

    function roleModules() {
        const metro = vendetta?.metro;
        if (!metro?.findByProps) throw new Error("Kettu Metro API unavailable.");

        const Dispatcher = metro.findByProps("dispatch", "subscribe");
        const UserStore = metro.findByProps("getUser", "getCurrentUser");
        const GuildMemberStore =
            metro.findByProps("getMember", "getMembers") ||
            metro.findByProps("getMember");

        const GuildRoleStore =
            metro.findByProps("getSortedRoles", "getRole") ||
            metro.findByProps("getSortedRoles") ||
            metro.findByProps("getRole");

        if (!Dispatcher?.dispatch) throw new Error("Could not find Flux dispatcher.");
        if (!UserStore?.getUser) throw new Error("Could not find UserStore.");
        if (!GuildMemberStore?.getMember) throw new Error("Could not find GuildMemberStore.");

        return { Dispatcher, UserStore, GuildMemberStore, GuildRoleStore };
    }


    function normalizeRoleColor(role) {
        const raw = role?.color ?? role?.colorInt ?? 0;
        const n = Number(raw) || 0;
        if (!n) return { color: 0, colorString: null };

        const hex = `#${n.toString(16).padStart(6, "0").slice(-6)}`;
        return { color: n, colorString: hex };
    }

    function getTargetRolePresentation(GuildRoleStore, guildId, targetMember) {
        const roleIds = new Set(
            Array.isArray(targetMember?.roles) ? targetMember.roles.map(String) : []
        );

        let sorted = [];
        try {
            sorted = GuildRoleStore?.getSortedRoles?.(guildId) ?? [];
        } catch {}

        if (!Array.isArray(sorted) || !sorted.length) {
            try {
                const snapshot =
                    GuildRoleStore?.getRolesSnapshot?.(guildId) ??
                    GuildRoleStore?.getUnsafeMutableRoles?.(guildId) ??
                    {};
                sorted = Object.values(snapshot);
            } catch {}
        }

        // Discord stores usually return roles low->high or high->low depending on build,
        // so sort explicitly by position descending.
        sorted = Array.isArray(sorted)
            ? [...sorted].sort(
                (a, b) => (Number(b?.position) || 0) - (Number(a?.position) || 0)
            )
            : [];

        const mine = sorted.filter(role => roleIds.has(String(role?.id ?? "")));

        const highestHoisted =
            mine.find(role => Boolean(role?.hoist)) ?? null;

        const highestColored =
            mine.find(role => (Number(role?.color ?? role?.colorInt) || 0) !== 0) ??
            null;

        const { color, colorString } = normalizeRoleColor(highestColored);

        return {
            hoistRoleId:
                highestHoisted?.id ??
                targetMember?.hoistRoleId ??
                targetMember?.hoist_role_id ??
                null,
            colorRoleId:
                highestColored?.id ??
                targetMember?.colorRoleId ??
                targetMember?.color_role_id ??
                null,
            color,
            colorString
        };
    }

    function getMember(GuildMemberStore, guildId, userId) {
        try {
            return GuildMemberStore.getMember(guildId, userId);
        } catch {
            return null;
        }
    }

    function dispatchLocalMemberUpdate(Dispatcher, guildId, user, memberLike) {
        Dispatcher.dispatch({
            type: "GUILD_MEMBER_UPDATE",
            guildId,
            guild_id: guildId,
            user,
            roles: Array.isArray(memberLike?.roles) ? [...memberLike.roles] : [],
            nick: memberLike?.nick ?? null,
            avatar: memberLike?.avatar ?? null,
            communication_disabled_until: memberLike?.communication_disabled_until ?? null,
            premium_since: memberLike?.premium_since ?? null,
            pending: Boolean(memberLike?.pending),
            joined_at: memberLike?.joined_at ?? new Date().toISOString(),
            flags: memberLike?.flags ?? 0,
            hoistRoleId:
                memberLike?.hoistRoleId ??
                memberLike?.hoist_role_id ??
                null,
            hoist_role_id:
                memberLike?.hoistRoleId ??
                memberLike?.hoist_role_id ??
                null,
            colorRoleId:
                memberLike?.colorRoleId ??
                memberLike?.color_role_id ??
                null,
            color_role_id:
                memberLike?.colorRoleId ??
                memberLike?.color_role_id ??
                null,
            color: memberLike?.color ?? 0,
            colorString:
                memberLike?.colorString ??
                memberLike?.color_string ??
                null,
            color_string:
                memberLike?.colorString ??
                memberLike?.color_string ??
                null
        });
    }


    function dispatchLocalHierarchyUpdate(Dispatcher, guildId, user, memberLike) {
        // Best-effort update for Discord's cached member-list item.
        // This is local-only and does not grant real roles/permissions.
        try {
            Dispatcher.dispatch({
                type: "GUILD_MEMBER_LIST_UPDATE",
                guildId,
                guild_id: guildId,
                ops: [
                    {
                        op: "UPDATE",
                        item: {
                            member: {
                                user,
                                roles: Array.isArray(memberLike?.roles)
                                    ? [...memberLike.roles]
                                    : [],
                                nick: memberLike?.nick ?? null,
                                avatar: memberLike?.avatar ?? null,
                                communication_disabled_until:
                                    memberLike?.communication_disabled_until ?? null,
                                premium_since: memberLike?.premium_since ?? null,
                                pending: Boolean(memberLike?.pending),
                                joined_at:
                                    memberLike?.joined_at ?? new Date().toISOString(),
                                flags: memberLike?.flags ?? 0
                            }
                        }
                    }
                ]
            });
        } catch (err) {
            try {
                vendetta?.logger?.error?.(
                    `[${PLUGIN_NAME}] hierarchy-update`,
                    err
                );
            } catch {}
        }

        // Force local consumers to recalculate their member-list view.
        // These are local Flux events only; they do not grant or edit server roles.
        try {
            Dispatcher.dispatch({
                type: "GUILD_MEMBER_LIST_INVALIDATE",
                guildId,
                guild_id: guildId
            });
        } catch {}

        try {
            Dispatcher.dispatch({
                type: "GUILD_MEMBER_UPDATE",
                guildId,
                guild_id: guildId,
                user,
                roles: Array.isArray(memberLike?.roles)
                    ? [...memberLike.roles]
                    : [],
                joined_at:
                    memberLike?.joined_at ??
                    memberLike?.joinedAt ??
                    new Date().toISOString()
            });
        } catch {}
    }

    function saveRoleSwap(record) {
        const index = storage.roleSwaps.findIndex(
            x => x.guildId === record.guildId && x.myUserId === record.myUserId
        );

        if (index >= 0) storage.roleSwaps[index] = record;
        else storage.roleSwaps.push(record);
    }

    async function roleSwapExecute(args) {
        const myUserId = String(getArg(args, "my-id") ?? "").match(/\d{17,20}/)?.[0];
        const targetUserId = String(getArg(args, "target-id") ?? "").match(/\d{17,20}/)?.[0];
        const guildId = String(getArg(args, "server-id") ?? "").match(/\d{17,20}/)?.[0];

        if (!myUserId || !targetUserId || !guildId) {
            toast("Role Swap: enter valid my-id, target-id and server-id.");
            return;
        }

        try {
            const { Dispatcher, UserStore, GuildMemberStore, GuildRoleStore } = roleModules();

            const me = UserStore.getUser(myUserId);
            const myMember = getMember(GuildMemberStore, guildId, myUserId);
            const targetMember = getMember(GuildMemberStore, guildId, targetUserId);

            if (!me) throw new Error("Your user is not cached.");
            if (!myMember) throw new Error("Your server member profile is not cached.");
            if (!targetMember) throw new Error("Target member is not cached in that server.");

            const original = {
                roles: Array.isArray(myMember.roles) ? [...myMember.roles] : [],
                nick: myMember.nick ?? null,
                avatar: myMember.avatar ?? null,
                communication_disabled_until: myMember.communication_disabled_until ?? null,
                premium_since: myMember.premium_since ?? null,
                pending: Boolean(myMember.pending),
                joined_at: myMember.joined_at ?? null,
                flags: myMember.flags ?? 0
            };

            const rolePresentation = getTargetRolePresentation(
                GuildRoleStore,
                guildId,
                targetMember
            );

            const spoofed = {
                roles: Array.isArray(targetMember.roles) ? [...targetMember.roles] : [],
                // Keep YOUR visible profile identity; only copy server roles.
                nick: myMember.nick ?? null,
                avatar: myMember.avatar ?? null,
                communication_disabled_until: myMember.communication_disabled_until ?? null,
                premium_since: myMember.premium_since ?? null,
                pending: Boolean(myMember.pending),
                joined_at: targetMember.joined_at ?? targetMember.joinedAt ?? myMember.joined_at ?? myMember.joinedAt ?? new Date().toISOString(),
                flags: myMember.flags ?? 0,
                hoistRoleId: rolePresentation.hoistRoleId,
                hoist_role_id: rolePresentation.hoistRoleId,
                colorRoleId: rolePresentation.colorRoleId,
                color_role_id: rolePresentation.colorRoleId,
                color: rolePresentation.color,
                colorString: rolePresentation.colorString,
                color_string: rolePresentation.colorString,
            };

            dispatchLocalMemberUpdate(Dispatcher, guildId, me, spoofed);
            dispatchLocalHierarchyUpdate(Dispatcher, guildId, me, spoofed);

            // A second local refresh after the spoof record has been saved helps
            // member-list/profile consumers that calculate hoist/color lazily.
            setTimeout(() => {
                try {
                    dispatchLocalMemberUpdate(
                        Dispatcher,
                        guildId,
                        me,
                        spoofed
                    );
                    dispatchLocalHierarchyUpdate(
                        Dispatcher,
                        guildId,
                        me,
                        spoofed
                    );
                } catch {}
            }, 250);

            saveRoleSwap({
                guildId,
                myUserId,
                targetUserId,
                original,
                spoofed
            });

            toast(`Role Swap: ${spoofed.roles.length} role${spoofed.roles.length === 1 ? "" : "s"} locked locally + hierarchy refreshed.`);
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] role-swap`, err); } catch {}
            toast(`Role Swap error: ${err?.message || String(err)}`);
        }
    }

    async function clearRoleSwapExecute(args) {
        const myUserId = String(getArg(args, "my-id") ?? "").match(/\d{17,20}/)?.[0];
        const guildId = String(getArg(args, "server-id") ?? "").match(/\d{17,20}/)?.[0];

        if (!myUserId || !guildId) {
            toast("Clear Role Swap: enter valid my-id and server-id.");
            return;
        }

        try {
            const { Dispatcher, UserStore } = roleModules();
            const me = UserStore.getUser(myUserId);
            if (!me) throw new Error("Your user is not cached.");

            const index = storage.roleSwaps.findIndex(
                x => x.guildId === guildId && x.myUserId === myUserId
            );

            if (index < 0) {
                toast("Clear Role Swap: no saved spoof for that server.");
                return;
            }

            const record = storage.roleSwaps[index];
            dispatchLocalMemberUpdate(Dispatcher, guildId, me, record.original);
            dispatchLocalHierarchyUpdate(Dispatcher, guildId, me, record.original);
            storage.roleSwaps.splice(index, 1);

            toast("Clear Role Swap: restored local profile • cosmetic chat off for this server.");
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] clear-role-swap`, err); } catch {}
            toast(`Clear Role Swap error: ${err?.message || String(err)}`);
        }
    }

    function restoreRoleSwaps() {
        if (!storage.roleSwaps.length) return;

        setTimeout(() => {
            try {
                const { Dispatcher, UserStore } = roleModules();

                for (const record of storage.roleSwaps) {
                    try {
                        const me = UserStore.getUser(record.myUserId);
                        if (!me) continue;
                        dispatchLocalMemberUpdate(
                            Dispatcher,
                            record.guildId,
                            me,
                            record.spoofed
                        );
                    } catch {}
                }
            } catch {}
        }, 1800);
    }

    async function bulkExecute(args) {
        const ids = parseIds(getArg(args, "targets"));
        const script = String(getArg(args, "script") ?? "");
        const dateInput = getArg(args, "date");
        const timeInput = getArg(args, "time");

        if (!ids.length) {
            toast("SDM Bulk: no valid user IDs.");
            return;
        }

        if (!script.trim()) {
            toast("SDM Bulk: script cannot be empty.");
            return;
        }

        const SAFE_MAX_TARGETS = 50;
        if (ids.length > SAFE_MAX_TARGETS) {
            toast(`SDM Bulk: max ${SAFE_MAX_TARGETS} IDs per run in stable mode.`);
            return;
        }

        try {
            const baseTimestamp = parseTimestamp(dateInput, timeInput);
            const baseMs = baseTimestamp.getTime();

            const {
                Dispatcher,
                UserStore,
                ChannelStore,
                ChannelActionCreators
            } = modules();

            let injected = 0;
            let opened = 0;
            let failed = 0;
            const failureDetails = [];

            // Conservative pacing for stability and normal API usage.
            const OPEN_SETTLE_MS = 1500;
            const BETWEEN_TARGETS_MS = 3000;

            for (let i = 0; i < ids.length; i++) {
                const userId = ids[i];

                try {
                    let user = null;
                    try { user = UserStore.getUser(userId); } catch {}
                    if (!user) user = fallbackUser(userId);

                    const existedBefore = Boolean(getDmChannelId(ChannelStore, userId));

                    const channelId = await openRealDm(
                        ChannelActionCreators,
                        ChannelStore,
                        UserStore,
                        userId
                    );

                    if (!existedBefore) {
                        opened++;
                        await sleep(OPEN_SETTLE_MS);
                    } else {
                        await sleep(350);
                    }

                    const messageId = fakeSnowflakeFromTimestamp(baseMs, i);
                    const timestamp = new Date(baseMs + i).toISOString();

                    const record = {
                        userId,
                        user,
                        channelId,
                        messageId,
                        content: script,
                        timestamp,
                        realDm: true
                    };

                    if (!dispatchFakeIncoming(Dispatcher, record)) {
                        throw new Error("MESSAGE_CREATE dispatch failed.");
                    }

                    saveRecord(record);
                    injected++;
                } catch (err) {
                    failed++;

                    const reason = formatError(err);

                    failureDetails.push(
                        `${userId} — ${reason || "unknown failure"}`
                    );

                    try {
                        vendetta?.logger?.error?.(
                            `[${PLUGIN_NAME}] target ${userId}`,
                            err
                        );
                    } catch {}
                }

                if (i < ids.length - 1) {
                    await sleep(BETWEEN_TARGETS_MS);
                }
            }

            toast(
                `SDM Bulk: ${injected}/${ids.length} injected • ${opened} opened` +
                (failed ? ` • ${failed} failed` : "") +
                (failureDetails.length
                    ? `\n${failureDetails.slice(0, 5).join("\n")}`
                    : "") +
                `\n• silent stable pacing`
            );
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}]`, err); } catch {}
            toast(`SDM Bulk error: ${err?.message || String(err)}`);
        }
    }

    async function clearExecute(args) {
        const raw = String(getArg(args, "targets") ?? "").trim();
        const ids = parseIds(raw);

        try {
            const { Dispatcher } = modules();
            let toClear;

            if (!raw || raw.toLowerCase() === "all") {
                toClear = [...storage.spoofDMs];
                storage.spoofDMs.splice(0, storage.spoofDMs.length);
            } else {
                const set = new Set(ids);
                toClear = storage.spoofDMs.filter(x => set.has(x.userId));
                const keep = storage.spoofDMs.filter(x => !set.has(x.userId));
                storage.spoofDMs.splice(0, storage.spoofDMs.length, ...keep);
            }

            for (const record of toClear) {
                try {
                    Dispatcher.dispatch({
                        type: "MESSAGE_DELETE",
                        channelId: record.channelId,
                        id: record.messageId
                    });
                } catch {}
            }

            toast(`Clear DM: removed ${toClear.length} local fake message${toClear.length === 1 ? "" : "s"}.`);
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] clear`, err); } catch {}
            toast(`Clear DM error: ${err?.message || String(err)}`);
        }
    }

    function restorePersistentDMs() {
        // Stable build: no synthetic message replay while Kettu is starting.
        return;
    }

    return {
        onLoad() {
            try {
                unpatchRoleReadLayer = installRoleReadLayer();
            } catch (err) {
                try {
                    vendetta?.logger?.error?.(
                        `[${PLUGIN_NAME}] role-read-layer-install`,
                        err
                    );
                } catch {}
            }


            try {
                unpatchCosmeticSend = installCosmeticSendInterceptor();
            } catch (err) {
                try {
                    vendetta?.logger?.error?.(
                        `[${PLUGIN_NAME}] cosmetic-chat-install`,
                        err
                    );
                } catch {}
            }

            unregisterBulk = vendetta.commands.registerCommand({
                name: "sdm-bulk",
                displayName: "sdm-bulk",
                description: "Open DMs and inject a local preset script for multiple users",
                displayDescription: "Open DMs and inject a local preset script for multiple users",
                options: [
                    {
                        name: "targets",
                        displayName: "targets",
                        description: "User IDs separated by spaces or commas",
                        displayDescription: "User IDs separated by spaces or commas",
                        type: 3,
                        required: true
                    },
                    {
                        name: "script",
                        displayName: "script",
                        description: "Preset script",
                        displayDescription: "Preset script",
                        type: 3,
                        required: true
                    },
                    {
                        name: "date",
                        displayName: "date",
                        description: "Fake DM date: YYYY-MM-DD (optional)",
                        displayDescription: "Fake DM date: YYYY-MM-DD (optional)",
                        type: 3,
                        required: false
                    },
                    {
                        name: "time",
                        displayName: "time",
                        description: "Fake DM time: HH:MM or HH:MM:SS (optional)",
                        displayDescription: "Fake DM time: HH:MM or HH:MM:SS (optional)",
                        type: 3,
                        required: false
                    }
                ],
                execute: bulkExecute
            });

            unregisterClear = vendetta.commands.registerCommand({
                name: "clear-dm",
                displayName: "clear-dm",
                description: "Clear spoofed DMs created by SDM Bulk",
                displayDescription: "Clear spoofed DMs created by SDM Bulk",
                options: [
                    {
                        name: "targets",
                        displayName: "targets",
                        description: 'User IDs to clear, or type "all"',
                        displayDescription: 'User IDs to clear, or type "all"',
                        type: 3,
                        required: false
                    }
                ],
                execute: clearExecute
            });

            unregisterRoleSwap = vendetta.commands.registerCommand({
                name: "role-swap",
                displayName: "role-swap",
                description: "Locally show your profile with another member's server roles",
                displayDescription: "Locally show your profile with another member's server roles",
                options: [
                    {
                        name: "my-id",
                        displayName: "my-id",
                        description: "Your Discord user ID",
                        displayDescription: "Your Discord user ID",
                        type: 3,
                        required: true
                    },
                    {
                        name: "target-id",
                        displayName: "target-id",
                        description: "Member whose roles should be copied locally",
                        displayDescription: "Member whose roles should be copied locally",
                        type: 3,
                        required: true
                    },
                    {
                        name: "server-id",
                        displayName: "server-id",
                        description: "Server ID",
                        displayDescription: "Server ID",
                        type: 3,
                        required: true
                    }
                ],
                execute: roleSwapExecute
            });

            unregisterClearRoleSwap = vendetta.commands.registerCommand({
                name: "clear-role-swap",
                displayName: "clear-role-swap",
                description: "Restore your original locally displayed server roles",
                displayDescription: "Restore your original locally displayed server roles",
                options: [
                    {
                        name: "my-id",
                        displayName: "my-id",
                        description: "Your Discord user ID",
                        displayDescription: "Your Discord user ID",
                        type: 3,
                        required: true
                    },
                    {
                        name: "server-id",
                        displayName: "server-id",
                        description: "Server ID",
                        displayDescription: "Server ID",
                        type: 3,
                        required: true
                    }
                ],
                execute: clearRoleSwapExecute
            });

        },

        onUnload() {
            try {
                if (typeof unpatchRoleReadLayer === "function") {
                    unpatchRoleReadLayer();
                }
            } catch {}
            unpatchRoleReadLayer = null;


            try {
                if (typeof unpatchCosmeticSend === "function") {
                    unpatchCosmeticSend();
                }
            } catch {}
            unpatchCosmeticSend = null;

            try { unregisterBulk?.(); } catch {}
            try { unregisterClear?.(); } catch {}
            try { unregisterRoleSwap?.(); } catch {}
            try { unregisterClearRoleSwap?.(); } catch {}
            unregisterBulk = null;
            unregisterClear = null;
            unregisterRoleSwap = null;
            unregisterClearRoleSwap = null;
        }
    };
})
