# SDM Bulk Alerts — Kettu

A Kettu/Vendetta-format plugin that adds:

`/sdm-bulk targets:<ids> message:<warning>`

It accepts Discord user IDs separated by spaces, commas, or semicolons.

## Safety / scope

- Must be run from a server channel.
- Only IDs that are members of the current server are eligible.
- Maximum 50 targets per run.
- Sends with a 1.5 second delay between DMs.
- Duplicate IDs are removed automatically.
- Failed/closed DMs are skipped and counted.

## Install after uploading to GitHub

Kettu currently supports the Vendetta-style plugin folder format: `manifest.json` + `index.js`.

1. Create a **public** GitHub repository.
2. Upload `manifest.json` and `index.js` to the repository root.
3. In Kettu: Settings → Plugins → `+`.
4. Paste the raw GitHub folder URL:

   `https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/`

5. Enable the plugin.
6. In a server channel type `/sdm-bulk`.

Example:

`/sdm-bulk targets:123456789012345678 234567890123456789 message:Important server warning: please check #announcements.`

## Notes

Discord changes internal client modules occasionally. If a future Discord/Kettu update changes the DM module names, the plugin may need a small compatibility update.
