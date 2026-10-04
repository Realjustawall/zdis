# Server bots and media

Open Server Settings → Server Bots. Built-in bots start disabled in each server.
Enabling a bot creates its server membership; disabling it removes that membership.
The install archive contains no configured bot accounts, passwords or database.
Startup creates trusted built-in identities with random, undisclosed passwords.

## Welcomer

Choose separate welcome and goodbye text channels. Customize both messages, image
titles, subtitle, background/text colors and an uploaded background image (8 MB).
The generated PNG is 1000×360 and includes a local profile image when available.
External avatar URLs are not fetched. Long text scales to fit; Persian text uses
right-to-left positioning. Preview renders the actual banner. Test buttons send
actual saved messages to the selected channel; save changes first.

Supported template variables: `{username}`, `{displayName}`, `{mention}`,
`{userId}`, `{avatar}`, `{server}`, `{memberCount}`, `{joinedAt}`, `{createdAt}`.
Variables are text substitutions. Avatar renders in the banner rather than
interpreting arbitrary HTML. Automatic roles are validated against the settings
author's current permissions and hierarchy before assignment.

Join/leave automation handles membership additions, invites, departures, kicks
and bans. Failed event delivery is retried by maintenance, up to five attempts.
Persisted message nonces prevent duplicate messages when an event is retried.

## Moderator

Implemented actions: warn/clear warnings, timeout/remove timeout, kick, permanent
or temporary ban/unban, purge up to 100 channel messages, lock/unlock, slowmode,
server nickname and role assignment/removal. Each action checks the caller's
permission and role hierarchy. Owners and higher-ranked members are protected.
Temporary bans expire through maintenance. Actions create durable cases and audit
records; an optional text channel receives bot reports.

AutoMod detects blocked keywords, invite links, unapproved HTTP(S) links, mention
spam, attachment spam, excessive capitals, rapid messages and repeated text.
Domain allowlists and role/channel exemptions are configurable. The response is
message rejection or a server timeout. Ordinary message creation, edits, forum
post creation and scheduled delivery check these rules. The flood history is
in memory per process; run one instance for the Windows SQLite edition.

Chat commands: `/bothelp`, `/warn`, `/warnings`, `/clearwarnings`, `/timeout`,
`/untimeout`, `/mute` (text only), `/unmute`, `/mutevoice`, `/unmutevoice`, `/kick`, `/ban`, `/tempban`,
`/unban`, `/purge`, `/lock`, `/unlock`, `/slowmode`, `/nickname`, `/role`, `/rank`
and `/top`. Commands require Application Commands permission. Use a username
preceded by `@` or a user ID. Timed commands accept seconds (60–2419200).
`/role @username roleId remove` removes a role; omit `remove` to assign it.

XP, a cooldown, levels, automatic role rewards and configurable exact/substring
responses use the real database and message service. Private forum posts and
shadow-banned messages do not trigger public automated responses. Encrypted
messages are not inspected for keywords or used for responses/XP.

Members can select/remove offered roles using the role button beside the message
box. Configure the whitelist under Levels & Responses. Only cosmetic roles and
ordinary chat permissions are allowed; administrative privileges are rejected.
Assignment revalidates the role and settings author's current authority. Changing
a listed role to include privileged permissions hides it and blocks new selections.

## Tickets

Enable tickets under Moderator and choose a category and support roles. Members
open requests with the support button beside the message box. The bot creates a
private text channel and initial message. A member can have one open ticket.
Support staff can claim, close and reopen tickets from Server Bots → Tickets.
Members can close their own tickets. Closing denies the requester's Send Messages
permission while preserving reading. A reopened ticket cannot conflict with
another open ticket for the same member.

Transcript downloads enforce private-channel access and export up to 10,000
undeleted messages as plain text. They are not immutable archives and do not
bundle uploaded attachment bytes. Moderation authority and channel access are
both required for support actions; a support role must grant the needed channel
access. Other members cannot read a ticket or its transcript.

## GIF, stickers and identities

The message composer includes separate GIF and sticker pickers, search, standard
packs, server packs and locally saved favorites. Eight actual animated GIFs and
eight PNG stickers ship locally and are included in offline precaching. Add
custom files through Server Settings → Expressions; GIF uploads must be actual
GIF files, up to 8 MB. Custom packs follow server/external-expression permissions.
There is no Tenor/GIPHY search integration. Direct messages currently offer the
standard pack; server custom packs are selected in server conversations.

BOT labels, green verified-bot checks and gold official-account checks appear
alongside names. Built-in bots receive BOT and verified-bot identities. Custom
integration bots receive BOT; administrators control trusted verification and
human official badges through the existing badge management. Cosmetic badges
include partner, early supporter, bug hunter, community moderator and booster;
cosmetic badges do not grant staff privileges.

## Scope and validation

This implementation is independent of ProBot; complete product equivalence is
not certified. Added modules include independent text/voice mutes, protected
members/roles and administrative rate limits, transactional anti-raid join limits,
structured embed messages, private-safe starboard, temporary voice channels and
expiring invites, server event logs, per-server credit/reputation profiles and
text/voice XP. Role colors use safe self-selectable roles. Bulk role operations
validate every target before committing. Voice movement re-authorizes publication
at the destination. Profiles support `/profile`, `/credits`, `/daily`, `/rep`,
`/title`, `/roll`; `/colors`, `/color`, `/tempvoice`, `/templink`, `/move` and
`/moveme` use actual server services. `/top` accepts `voice`/`text` and
`day`/`week`/`month`; period totals use earned XP history from this version onward.

The local credit ledger is separate from ProBot's global account economy. Paid
ProBot subscription/bot-account management, music playback, giveaways, social-feed
subscriptions, short URL generation and reaction-linked role panels are not
provided. The ticket module has one open ticket per member, claim/close/reopen and
private transcripts; custom ticket forms and every external ProBot panel option
are not certified. Webhook/integration messages are not passed through the member
AutoMod pipeline. Do not advertise full ProBot parity or 100% coverage.

Validation on Windows/SQLite: `npm run test:bots` passes 26 real service/database
tests covering migrations, validation, permissions, hierarchy, cases, welcome/
goodbye delivery, PNG generation, AutoMod, XP, roles, commands, bans, purge,
private tickets/transcripts, self-selected-role security, animated custom GIF
storage, banner retention and scheduled-message revalidation. Every successful
run removes its temporary database. `npm run test:activities` passes 14 tests.
Production TypeScript/Vite build and offline-precache verification pass.

Playwright checked real React GIF/sticker loading, favorites, token insertion,
picker exclusivity, all bot-setting tabs, save payload, 13 moderation form actions
and 390px/320px mobile layouts. The phone message field measured 364px/294px,
respectively. The new self-role picker has passed compilation and backend tests;
its browser interaction subsequently passed against a fresh real HTTP server.
The real-server Playwright scenario passes in desktop Chrome and mobile Chrome
emulation: settings persistence, PNG preview, self-role assignment/removal,
private ticket creation/transcript and custom GIF delivery. Nine additional
HTTP/WebSocket scenarios pass, including welcome delivery, AutoMod, moderation,
private-channel metadata isolation and 20 concurrent ticket requests collapsing
to one ticket. The complete backend suite passes, including 67 API tests,
23 realtime tests, 13 network tests and 10 platform E2EE tests. Mobile toolbar
focus and accessible settings labels were corrected from these browser tests.
Heavy-load operation of the new bots, other browser engines and physical phones
have not been validated. Earlier load results are not certification of these bots.

Restart the application after installing the updated source and built client.
The latest backend runs on port 18181, verified through login, policy APIs and authenticated WebSocket. The updated source and production client
are included in the install archive; the live preview has not been replaced.

Successful bot tests clean up their own isolated database/uploads. One database
directory from an earlier syntax-failing run remains under `.tmp/bots-qa-*`:
automatic action review rejected its explicit recursive removal. `.tmp` and all
runtime/test output are excluded from the install archive.
