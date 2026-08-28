(() => {
    const PLUGIN_NAME = "Spoof Bulk";
    const MAX_TARGETS = 100;

    let unregisterCommand = null;

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
            const toasts = vendetta?.ui?.toasts;
            const assets = vendetta?.ui?.assets;

            if (toasts?.showToast) {
                const icon =
                    assets?.getAssetIDByName?.("ic_message") ??
                    assets?.getAssetIDByName?.("Small");

                toasts.showToast(String(message), icon);
                return;
            }
        } catch {}

        try {
            vendetta?.logger?.log?.(`[${PLUGIN_NAME}] ${message}`);
        } catch {}
    }

    function findModules() {
        const metro = vendetta?.metro;
        if (!metro?.findByProps) {
            throw new Error("Kettu Metro API is unavailable.");
        }

        const MessageStore =
            metro.findByProps("getMessages", "getMessage") ||
            metro.findByProps("getMessages");

        const UserStore =
            metro.findByProps("getUser", "getCurrentUser") ||
            metro.findByProps("getUser");

        if (!MessageStore?.getMessages) {
            throw new Error("Could not find Discord MessageStore.");
        }

        return { MessageStore, UserStore };
    }

    function currentChannelId(ctx) {
        return (
            ctx?.channel?.id ||
            ctx?.channel_id ||
            ctx?.channelId ||
            null
        );
    }

    // Discord snowflakes are time based. This creates a locally unique
    // snowflake-like ID without making any network request.
    function fakeSnowflake(offset = 0) {
        const DISCORD_EPOCH = 1420070400000n;
        const now = BigInt(Date.now() + offset);
        return String((now - DISCORD_EPOCH) << 22n | BigInt(Math.floor(Math.random() * 4194303)));
    }

    function fallbackUser(id) {
        return {
            id,
            username: `User ${id.slice(-4)}`,
            global_name: null,
            discriminator: "0",
            avatar: null,
            bot: false,
            system: false
        };
    }

    function buildFakeMessage(channelId, user, content, index) {
        const timestamp = new Date(Date.now() + index).toISOString();

        return {
            id: fakeSnowflake(index),
            type: 0,
            channel_id: channelId,
            guild_id: null,
            author: user,
            content,
            timestamp,
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
            webhook_id: null,
            flags: 0,
            components: [],
            sticker_items: [],
            nonce: null
        };
    }

    function injectLocalMessage(MessageStore, channelId, message) {
        const messages = MessageStore.getMessages(channelId);

        if (!messages) {
            throw new Error("The current channel message cache is unavailable.");
        }

        // Newer Discord/Kettu builds expose receiveMessage on the channel cache.
        if (typeof messages.receiveMessage === "function") {
            messages.receiveMessage(message);
            return;
        }

        // Compatibility fallback for builds that expose the backing map/array.
        if (messages._map && messages._array) {
            messages._map[message.id] = message;
            messages._array.push(message);
            return;
        }

        throw new Error("This Kettu build does not expose a writable message cache.");
    }

    async function execute(args, ctx) {
        const rawTargets = getArg(args, "targets");
        const script = String(getArg(args, "script") ?? "");

        if (!script.trim()) {
            toast("Spoof Bulk: script cannot be empty.");
            return;
        }

        const ids = parseIds(rawTargets);

        if (!ids.length) {
            toast("Spoof Bulk: no valid user IDs found.");
            return;
        }

        if (ids.length > MAX_TARGETS) {
            toast(`Spoof Bulk: max ${MAX_TARGETS} users per run.`);
            return;
        }

        const channelId = currentChannelId(ctx);

        if (!channelId) {
            toast("Spoof Bulk: open a channel first.");
            return;
        }

        try {
            const { MessageStore, UserStore } = findModules();

            let injected = 0;

            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];

                let user = null;
                try {
                    user = UserStore?.getUser?.(id) || null;
                } catch {}

                if (!user) user = fallbackUser(id);

                const message = buildFakeMessage(
                    channelId,
                    user,
                    script,
                    i
                );

                injectLocalMessage(MessageStore, channelId, message);
                injected++;
            }

            toast(
                `Spoof Bulk: injected ${injected} local message${injected === 1 ? "" : "s"}.`
            );
        } catch (err) {
            try {
                vendetta?.logger?.error?.(`[${PLUGIN_NAME}]`, err);
            } catch {}

            toast(`Spoof Bulk error: ${err?.message || String(err)}`);
        }
    }

    return {
        onLoad() {
            unregisterCommand = vendetta.commands.registerCommand({
                name: "spoof-bulk",
                displayName: "spoof-bulk",
                description: "Locally inject the same fake incoming message from multiple users",
                displayDescription: "Locally inject the same fake incoming message from multiple users",
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
                        description: "Fake incoming message text",
                        displayDescription: "Fake incoming message text",
                        type: 3,
                        required: true
                    }
                ],
                execute
            });

            toast("Spoof Bulk enabled — local only.");
        },

        onUnload() {
            try {
                unregisterCommand?.();
            } catch {}

            unregisterCommand = null;
        }
    };
})
