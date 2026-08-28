(() => {
    const PLUGIN_NAME = "SDM Bulk Alerts";
    const MAX_TARGETS = 50;
    const SEND_DELAY_MS = 1500;

    let unregisterCommand = null;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function getArg(args, name) {
        const item = Array.isArray(args) ? args.find(x => x?.name === name) : null;
        return item?.value ?? "";
    }

    function parseUserIds(input) {
        const out = [];
        const seen = new Set();

        for (const token of String(input ?? "").split(/[\s,;]+/g)) {
            const match = token.match(/\d{17,20}/);
            if (!match) continue;

            const id = match[0];
            if (!seen.has(id)) {
                seen.add(id);
                out.push(id);
            }
        }
        return out;
    }

    function toast(message) {
        try {
            const toasts = vendetta?.ui?.toasts;
            const assets = vendetta?.ui?.assets;
            if (toasts?.showToast) {
                const icon = assets?.getAssetIDByName?.("Small");
                toasts.showToast(String(message), icon);
                return;
            }
        } catch {}
        try { vendetta?.logger?.log?.(message); } catch {}
    }

    function findDiscordModules() {
        const metro = vendetta?.metro;
        if (!metro?.findByProps) throw new Error("Kettu Metro API is unavailable.");

        const MessageActions =
            metro.findByProps("sendMessage", "editMessage") ||
            metro.findByProps("sendMessage");

        const PrivateChannelActions =
            metro.findByProps("openPrivateChannel") ||
            metro.findByProps("createDM") ||
            metro.findByProps("openPrivateChannel", "closePrivateChannel");

        const GuildMemberStore =
            metro.findByProps("getMember", "getMembers") ||
            metro.findByProps("getMember");

        const ChannelStore =
            metro.findByProps("getChannel", "getDMFromUserId") ||
            metro.findByProps("getChannel");

        if (!MessageActions?.sendMessage) {
            throw new Error("Could not find Discord's sendMessage module.");
        }

        return { MessageActions, PrivateChannelActions, GuildMemberStore, ChannelStore };
    }

    async function getOrCreateDmChannel(userId, modules) {
        const { PrivateChannelActions, ChannelStore } = modules;

        try {
            const existing = ChannelStore?.getDMFromUserId?.(userId);
            if (existing) return typeof existing === "string" ? existing : existing.id;
        } catch {}

        if (PrivateChannelActions?.openPrivateChannel) {
            const result = await PrivateChannelActions.openPrivateChannel(userId);
            if (typeof result === "string") return result;
            if (result?.id) return result.id;

            await sleep(250);
            try {
                const dm = ChannelStore?.getDMFromUserId?.(userId);
                if (dm) return typeof dm === "string" ? dm : dm.id;
            } catch {}
        }

        if (PrivateChannelActions?.createDM) {
            const result = await PrivateChannelActions.createDM(userId);
            if (typeof result === "string") return result;
            if (result?.id) return result.id;
        }

        throw new Error("Could not create/open a DM channel.");
    }

    async function sendDm(userId, content, modules) {
        const channelId = await getOrCreateDmChannel(userId, modules);
        await modules.MessageActions.sendMessage(
            channelId,
            {
                content,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: []
            },
            true,
            {}
        );
    }

    function currentGuildId(ctx) {
        return (
            ctx?.guild?.id ||
            ctx?.guild_id ||
            ctx?.guildId ||
            ctx?.channel?.guild_id ||
            ctx?.channel?.guildId ||
            null
        );
    }

    function isCurrentServerMember(guildId, userId, GuildMemberStore) {
        if (!guildId) return false;
        try {
            return Boolean(GuildMemberStore?.getMember?.(guildId, userId));
        } catch {
            return false;
        }
    }

    async function runBulk(args, ctx) {
        const rawTargets = getArg(args, "targets");
        const message = String(getArg(args, "message") ?? "").trim();

        if (!message) {
            toast("SDM Bulk: message cannot be empty.");
            return;
        }

        const ids = parseUserIds(rawTargets);

        if (!ids.length) {
            toast("SDM Bulk: no valid user IDs found.");
            return;
        }

        if (ids.length > MAX_TARGETS) {
            toast(`SDM Bulk: max ${MAX_TARGETS} users per run.`);
            return;
        }

        const guildId = currentGuildId(ctx);
        if (!guildId) {
            toast("SDM Bulk must be run inside a server channel.");
            return;
        }

        const modules = findDiscordModules();

        const eligible = [];
        const skipped = [];

        for (const id of ids) {
            if (isCurrentServerMember(guildId, id, modules.GuildMemberStore)) {
                eligible.push(id);
            } else {
                skipped.push(id);
            }
        }

        if (!eligible.length) {
            toast("SDM Bulk: none of those IDs are members of this server.");
            return;
        }

        toast(`SDM Bulk: sending ${eligible.length} alert${eligible.length === 1 ? "" : "s"}…`);

        let sent = 0;
        let failed = 0;

        for (const userId of eligible) {
            try {
                await sendDm(userId, message, modules);
                sent++;
            } catch (err) {
                failed++;
                try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] Failed ${userId}`, err); } catch {}
            }

            if (sent + failed < eligible.length) {
                await sleep(SEND_DELAY_MS);
            }
        }

        let result = `SDM Bulk: sent ${sent}/${eligible.length}`;
        if (failed) result += ` • failed ${failed}`;
        if (skipped.length) result += ` • skipped ${skipped.length} non-members`;
        toast(result);
    }

    return {
        onLoad() {
            try {
                unregisterCommand = vendetta.commands.registerCommand({
                    name: "sdm-bulk",
                    displayName: "sdm-bulk",
                    description: "DM the same server alert to selected server members",
                    displayDescription: "DM the same server alert to selected server members",
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
                            name: "message",
                            displayName: "message",
                            description: "Alert message to send",
                            displayDescription: "Alert message to send",
                            type: 3,
                            required: true
                        }
                    ],
                    execute: runBulk
                });

                toast("SDM Bulk Alerts enabled.");
            } catch (err) {
                try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] Failed to load`, err); } catch {}
                throw err;
            }
        },

        onUnload() {
            try { unregisterCommand?.(); } catch {}
            unregisterCommand = null;
        }
    };
})