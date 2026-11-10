# pi-matrix-bridge

Bridge [Matrix](https://matrix.org) into pi — talk to your pi coding agent from any Matrix client.

Remote users can interact with your pi coding agent via Element, FluffyChat, or any other Matrix app.

> Matrix-only fork of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT). The original supports Telegram, WhatsApp, Slack, Discord, and Matrix; this fork keeps Matrix only.

## Features

- 💬 Matrix support (Element X, Element Web, FluffyChat, any homeserver)
- 🔐 Challenge-based authentication (6-digit codes)
- 🎛️ Interactive menu (`/matrix-bridge`) for setup and management
- 🔒 Single-instance guard — prevents duplicate bot polling with sub-agents
- 📊 Live status widget (toggleable)
- 💾 Persistent config (auth state, auto-connect, widget preference)
- 🔧 Tool call visibility for remote users
- 💭 Live streaming — thinking and the response stream into editable messages so you can steer/stop mid-turn
- 🎨 Matrix-native formatting — fenced code blocks, inline code, spoilers for reasoning, and an `/html` escape hatch
- ⏳ Rate-limit handling — backs off and retries on Matrix 429s so messages are never silently dropped
- 📝 Multi-turn conversation support
- 🔑 Secure permissions (chmod 600 for config files, 700 for directories)

## Setup

### 1. Install

```bash
pi install npm:pi-matrix-bridge
```

### 2. Configure Matrix

Works with any Matrix homeserver — Element X, Element Web, FluffyChat, etc. The bot auto-joins rooms it's invited to.

1. Register a bot account on your homeserver (or reuse an existing user)
2. Get a **dedicated** access token by logging in via the API (see below)
3. Note your homeserver URL (e.g. `https://matrix.org`)

> **Generate a fresh token — don't reuse an existing one.** Reusing the access
> token from a client you're already signed into (e.g. Element Web's
> **Settings → Help & About → Advanced**) shares that client's device and crypto
> store, which causes E2EE key conflicts and decryption failures. Instead, log in
> via the API to mint a brand-new device + token just for the bridge:
>
> ```bash
> curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
>   -H 'Content-Type: application/json' \
>   -d '{
>     "type": "m.login.password",
>     "identifier": { "type": "m.id.user", "user": "your_username" },
>     "password": "YOUR_ACCOUNT_PASSWORD",
>     "initial_device_display_name": "pi-matrix-bridge"
>   }'
> ```
>
> Replace `your_username`, the password, and the homeserver URL. The JSON
> response contains `access_token` (use it below) and a fresh `device_id`. To
> revoke it later, log that device out from your Matrix client.

```bash
/matrix-bridge configure matrix <homeserver-url> <access-token>
```

Or set via environment variables:
```bash
export PI_MATRIX_BRIDGE_HOMESERVER="https://matrix.org"
export PI_MATRIX_BRIDGE_ACCESS_TOKEN="syt_..."
```

E2EE is **on by default**. The bot's device is a normal Matrix session, so you can
verify it from Element (or any client that supports SAS) like any other session:

1. In Element: **Settings → Sessions** (or "Security & Privacy → Sessions"), find the
   session named with `initial_device_display_name` (e.g. `pi-matrix-bridge`) and
   choose **Verify session**.
2. The bridge auto-accepts and shows 7 emoji in your pi terminal (and, as a fallback,
   numbers). Compare them with what Element shows.
3. If they match: `/matrix-bridge verify accept <id>` in pi (the id is in the emoji
   message, or run `/matrix-bridge verify` to list pending verifications). If they
   don't: `/matrix-bridge verify mismatch <id>`.

Both sides must confirm for verification to complete, so the bridge never confirms
on its own — you are the one comparing the emoji. Once verified, the session shows
as verified/cross-signed in Element and room keys are shared normally.

> **Verification and the crypto store.** The device's identity keys live in
> `~/.pi/matrix-bridge-crypto.json` (mode 0600 — it holds room keys). Keep that file:
> if it is deleted, the bridge generates new keys for the same device on the next
> start and you have to verify the session again. See
> [Crypto store](#crypto-store) in Troubleshooting.

Set `"encryption": false` in the `matrix` config to disable — useful for non-encrypted rooms only, or to bypass crypto-store/server desync (e.g. `M_UNKNOWN: One time key … already exists`). **Caveat:** with E2EE off, the homeserver sees plaintext, and the bot can't participate in encrypted rooms at all.

### 3. Connect

```bash
/matrix-bridge connect
```

### 4. Authenticate Users

When a user messages your bot for the first time, they'll receive a 6-digit challenge code.
The code is displayed in your pi terminal. Share it with the user (e.g., via DM).

The user enters the code in the bot chat to become a trusted user.

## Commands

| Command | Description |
|---|---|
| `/matrix-bridge` | Open interactive menu (configure, connect, widget, help) |
| `/matrix-bridge status` | Show connection and user status |
| `/matrix-bridge connect` | Connect to Matrix |
| `/matrix-bridge disconnect` | Disconnect from Matrix |
| `/matrix-bridge configure matrix <homeserver-url> <access-token>` | Set Matrix credentials via CLI |
| `/matrix-bridge verify` | List pending device verifications (emoji/numeric SAS) |
| `/matrix-bridge verify accept <id>` | Confirm the SAS values matched — completes verification |
| `/matrix-bridge verify mismatch <id>` | Report that the SAS values did not match |
| `/matrix-bridge verify cancel <id>` | Abort a verification |
| `/matrix-bridge widget` | Toggle status widget on/off |
| `/matrix-bridge toggletools` | Toggle tool call visibility in remote messages |
| `/matrix-bridge togglethinking` | Toggle live thinking (💭) visibility |
| `/matrix-bridge help` | Show command reference |

### Admin commands (in DM with the bot)

Trusted users can DM the bot directly to manage state. Reply with `/help` for the full list. Commands accept either a `/` or `!` prefix (e.g. `/help` or `!help`).

| Command | Description |
|---|---|
| `/help` | Show admin command reference |
| `/trusted` | List trusted users |
| `/revoke <userId>` | Revoke trust for a user |
| `/channels` | List enabled channels |
| `/enable <chatId> <all\|mentions\|trusted-only>` | Enable a channel |
| `/disable <chatId>` | Disable a channel |
| `/toggletools` | Toggle tool call visibility in replies |
| `/togglethinking` | Toggle live thinking (💭) visibility |
| `/session` | Show current session info (model, context usage, status) |
| `/shutdown` | Stop pi — under systemd this restarts into a fresh session ([see below](#headless-always-on-systemd)) |

Any authorized user (not just admins) can also send:

| Message | Description |
|---|---|
| `stop` | Interrupt the current turn. Also accepts `/stop` or `!stop`. |

## Live streaming

Both the model's **thinking** (💭) and its **response** stream into messages that are edited in place (token-by-token, throttled) as they're generated — so you can read where a turn is heading and `stop` (or steer) before it commits to a wrong action. Each **tool call** (🔧) appears the moment it starts running (handy for tools that take a few seconds), and its **output** (↳, truncated) is appended when it finishes. The typing indicator stays active alongside them.

Thinking is **on by default** — toggle with `/togglethinking` (DM admin) or `/matrix-bridge togglethinking`, or set `"hideThinking": true` in the config. (The response always streams.) Reasoning is wrapped in a Matrix **spoiler**, so it stays collapsed in Element until tapped — the answer doesn't get buried under long reasoning.

## Formatting

Messages are sent as Matrix `m.text` with a `formatted_body` (`org.matrix.custom.html`), so clients render real formatting instead of raw markdown:

- **Code blocks** — ```` ```lang ```` fences become `<pre><code class="language-lang">`. An unterminated fence (a block still being streamed) renders as code up to the end of the message, so it doesn't flash raw backticks. Fences longer than three backticks work, and embedded fences are preserved.
- **Inline code** — `` `x` `` becomes `<code>`.
- **Bold / italic / links** — `**bold**`, `*italic*`, `[text](url)`.
- **Spoilers** — `||hidden||` becomes Matrix's native `<span data-mx-spoiler>` (tap to reveal). Used for the model's 💭 reasoning.
- **Tool output** — multi-line tool output is wrapped in a fence (the fence grows past any backticks in the output), so indentation, diffs and markdown-ish characters stay literal.
- **Raw HTML** — ordinary text is HTML-escaped, so `<tag>` stays visible. To send arbitrary Matrix HTML, start the message with `/html` on its own line (or `/html <p>…</p>`); the rest is passed through as `formatted_body` verbatim, with a tag-stripped plain-text fallback as `body`. Useful for formatting the bridge doesn't translate (tables, headings, `<hr>`, custom spoilers).

## Rate-limit handling

Matrix homeservers return `429 Too Many Requests` (with a `retry_after_ms` hint) when you send too fast — and live streaming, which edits messages many times per turn, makes bursts common. Rather than letting a rate-limited message silently vanish, the bridge routes every outbound send and edit through a single serialized queue:

- On a 429 it pauses all sends, waits the server-requested `retry_after`, then retries the same message — so nothing is dropped, and ordering is preserved.
- The first message delivered after a backoff carries a small note (`⏳ *(delayed — rate limited)*`) so you know a delay occurred.
- Typing indicators are suppressed while rate-limited (they'd only add load), and rapid in-place edits to the same message are coalesced so a backoff doesn't flush a run of stale intermediate edits.

This is automatic — there's nothing to configure.

## Configuration

Config is stored at `~/.pi/matrix-bridge.json` with secure permissions (chmod 600).

Example config:
```json
{
  "matrix": { "homeserverUrl": "https://matrix.org", "accessToken": "syt_...", "encryption": true },
  "auth": {
    "trustedUsers": ["matrix:@alice:matrix.org"]
  },
  "showWidget": true
}
```

## Environment Variables

Environment variables override file config:

- `PI_MATRIX_BRIDGE_AUTO_CONNECT` — connect on startup; overrides `autoConnect` from the config file in both directions (set it to `0` to force the bridge dormant). **Defaults to off** unless `"autoConnect": true` is set in `~/.pi/matrix-bridge.json`. With neither set the plugin stays dormant (no connection) and you connect with `/matrix-bridge connect`. See [Headless / always-on](#headless-always-on-systemd).
- `PI_MATRIX_BRIDGE_HOMESERVER` — Matrix homeserver URL (e.g. `https://matrix.org`)
- `PI_MATRIX_BRIDGE_ACCESS_TOKEN` — Matrix access token

## Security

- Config file: `~/.pi/matrix-bridge.json` (chmod 600 - owner read/write only)
- Config directory: `~/.pi/` (chmod 700 - owner only)
- Environment variables take precedence over config file
- Challenge-based authentication for all new users
- Transport-namespaced user IDs prevent impersonation

## Troubleshooting

### Crypto store

The Rust crypto store is kept in-process and snapshotted to
`~/.pi/matrix-bridge-crypto.json` (mode 0600) every few seconds while the bridge is
connected, plus on disconnect. That file is what keeps the device's identity keys,
verification/trust state, and megolm sessions stable across restarts.

- **Upgrading from 0.5.x:** the old native store (`~/.pi/matrix-bridge-crypto/`,
  `~/.pi/matrix-bridge-store.json`) is no longer used. The bridge device keeps its
  device ID but gets new identity keys, so verify the session once more, and revoke
  the stale device in Element (**Settings → Sessions → log out**). You can then
  delete the old files.
- **Reset:** delete `~/.pi/matrix-bridge-crypto.json` to start from a clean crypto
  store. The device is then unverified and needs verifying again.
- **Corrupt snapshot:** startup fails with a clear error instead of silently
  generating new keys (which would un-verify the device without warning). Delete the
  file to recover.
- **Backups:** the snapshot contains your room keys — treat it like a session token.

**`⚠️ Matrix setup error: M_UNKNOWN: One time key signed_curve25519:… already exists`**

The bot's crypto store has drifted out of sync with the homeserver (the device's one-time keys no longer match).

1. Stop `pi`
2. Delete the crypto store snapshot: `rm ~/.pi/matrix-bridge-crypto.json`
3. Mint a **fresh access token / device** and reconfigure with it:

```bash
curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "your_username" },
    "password": "YOUR_ACCOUNT_PASSWORD",
    "initial_device_display_name": "pi-matrix-bridge"
  }'
```

Then set the new `access_token` (via `/matrix-bridge configure matrix <homeserver> <token>` or `PI_MATRIX_BRIDGE_ACCESS_TOKEN`) and reconnect, and verify the new session (`/matrix-bridge verify`). Alternatively, set `"encryption": false` in the `matrix` config to bypass E2EE entirely (the homeserver then sees plaintext).

## Architecture

Uses pi's native `sendUserMessage()` and `turn_end` events for two-way communication.
No tool-loop hacks needed — this is the pi-native way.

Single-instance connection guard prevents duplicate polling when sub-agents spawn
(global flag + PID lock file at `~/.pi/matrix-bridge.lock`).

## Headless / always-on (systemd)

Run pi as a dedicated, always-on Matrix endpoint you can talk to from your phone — including starting a fresh conversation remotely.

### Activation

The plugin **does not connect on startup unless `PI_MATRIX_BRIDGE_AUTO_CONNECT=1` or `"autoConnect": true` is in the config file**. This lets a dedicated headless instance own the bot (it sets the env var) while a desktop pi with the same plugin installed stays dormant — no connection, no status widget, no notices. The desktop can still connect on demand with `/matrix-bridge connect`.

### Install the service

The bundled installer writes a `systemd --user` unit, enables lingering (so it runs without an active login), and starts it:

```bash
./scripts/install-systemd.sh
```

Options: `--name` (unit name, default `pi-matrix-bridge`), `--workdir` (the agent's working directory — **required**; prompted if omitted), `--pi` (path to the `pi` binary), and `--uninstall`. If `PI_MATRIX_BRIDGE_HOMESERVER` / `PI_MATRIX_BRIDGE_ACCESS_TOKEN` are exported in your shell, they're baked into the unit; otherwise pi reads `~/.pi/matrix-bridge.json`.

The generated unit sets `PI_MATRIX_BRIDGE_AUTO_CONNECT=1`, `Restart=always`, and `RestartSec=2`. Manage it with:

```bash
systemctl --user status pi-matrix-bridge
journalctl --user -u pi-matrix-bridge -f
```

### `/shutdown` = fresh session

pi runs headless in "print" mode, but the bridge's open sockets keep the process alive as a daemon. The `/shutdown` admin command stops that process; with `Restart=always`, systemd relaunches pi, and since there's no `--continue`/`--resume`, it comes back in a **brand-new session**. The restart *is* the new session — no PTY, no tmux, no hacks.

> **Note:** `/shutdown` resets the conversation for everyone and causes a few seconds of downtime. That's fine for a single-user mobile bridge. Without a supervisor, `/shutdown` simply stops pi — exactly what the name says.

## Development

```bash
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run test         # run tests
npm run lint         # biome lint
npm run lint:fix     # biome lint with auto-fix
```

## Credits

Forked from [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) by tintinweb and contributors (MIT). This fork strips it down to Matrix only.

## License

MIT — see [LICENSE](LICENSE).
