# Hush Rules

Automatically mute tabs by custom domain and URL rules.

Hush Rules is a Chrome (Manifest V3) extension. When a tab's URL matches any
enabled rule, the whole tab is muted with `chrome.tabs.update({ muted: true })`.
It only controls tab audio: it never accesses the microphone, injects content
scripts or modifies web pages.

## Install (Load unpacked)

1. Build the extension (`dist/` is not committed):
   ```bash
   pnpm install
   pnpm build
   ```
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `dist/` directory.
5. Pin "Hush Rules" from the extensions menu to reach the popup.

Requires Chrome 120 or newer.

## Development

| Script           | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`       | `vite build --watch` in development mode (unminified, source maps) to `dist/` |
| `pnpm build`     | Production build to `dist/`                                                   |
| `pnpm test`      | Vitest unit tests                                                             |
| `pnpm typecheck` | `tsc --noEmit`                                                                |
| `pnpm icons`     | Regenerates `public/icons/*.png` (no image dependencies)                      |

(`npm run <script>` works the same.) While `pnpm dev` is running, click the
reload button on the extension card in `chrome://extensions` after each
rebuild; MV3 extension pages and service workers do not hot-reload.

### Project layout

```
public/manifest.json, public/icons/   copied verbatim into dist/
src/core/        pure logic, no chrome.* calls (unit tested)
  rules.ts       input normalization, matching, duplicate detection
  decide.ts      per-tab decision: mute / restore / leave alone
  controller.ts  event handling over an injectable BrowserApi
  mute-label.ts  human-readable mute state
src/shared/      chrome.storage helpers, message types, safe DOM helpers, CSS
src/background/  service worker: Chrome adapter + event listeners
src/popup/       toolbar popup
src/options/     options page (rule list, form, URL tester)
tests/           Vitest tests and an in-memory fake browser
```

## Testing

```bash
pnpm test
```

Automated tests cover:

- Exact domain matching and the "Include subdomains" toggle.
- Rejection of lookalike hosts (`notexample.com`, `example.com.evil.test`,
  `example.com@evil.test`, …).
- Case, whitespace and trailing-dot normalization; rejection of invalid or
  ambiguous input (`example.com/path`, ports, wildcards, non-HTTP schemes).
- URL-prefix semantics: exact origin, case-sensitive path prefix, ignored
  query strings and fragments, `/news` vs `/news/`.
- Disabled rules and the global off switch.
- Controller behavior against `tests/fake-browser.ts`: restoring audio only for
  mutes this extension owns, already-muted tabs, manual overrides (kept across
  same-document navigation, cleared on reload/new document), user and
  other-extension changes, state surviving a new controller instance
  ("service worker restart"), closed tabs, navigation races and concurrent
  events.

**Important:** the controller tests run against an in-memory fake of the
Chrome APIs. They verify the logic under the documented API semantics, but
they do **not** prove real Chrome event ordering, timing or service worker
lifecycle. Use the manual acceptance steps below for that.

### Manual acceptance steps (Chrome)

Load `dist/` as described above. Open the service worker console from
`chrome://extensions` → Hush Rules → "service worker" to watch for errors.
Use any site that plays audio (or check the speaker icon / tab context menu,
which shows "Unmute site"/"Unmute tab").

1. **Domain rule** – Options → add `example.com` (domain). Open
   `https://example.com` → the tab is muted (tab strip shows a muted speaker).
   Open `https://www.example.com` → *not* muted. Edit the rule, enable
   "Include subdomains" → the `www` tab becomes muted without reloading.
2. **Leaving a match** – In the muted tab navigate to another site → the tab
   is unmuted.
3. **Existing tabs** – With some matching tabs open, disable the rule → those
   tabs unmute; enable it → they mute again. Same for the popup's
   "Automatic muting" toggle, and for deleting the rule.
4. **Already-muted tab** – Mute a non-matching tab via the tab context menu,
   then navigate it to a matching site and back away → it stays muted (popup
   says "Muted by you").
5. **Manual override** – On a matching, auto-muted page click "Unmute tab" in
   the popup → audio plays. On a single-page app (for example a video site),
   navigate inside the app → still unmuted. Press reload → muted again.
6. **Manual mute + global off** – On a non-matching page click "Mute tab",
   then turn automatic muting off → the tab stays muted.
7. **User change is respected** – On an auto-muted tab use the tab context
   menu to unmute it → it is not re-muted until the page reloads or a new
   document loads.
8. **SPA URL changes** – Add a URL-prefix rule like
   `https://www.youtube.com/watch`. Start on the YouTube home page, then click
   a video (same-document navigation) → muted. Go back to the home page →
   unmuted.
9. **Service worker restart** – Auto-mute a tab, then in
   `chrome://serviceworker-internals` (or by waiting ~30 s idle) stop the
   Hush Rules worker. Navigate the tab away → it is unmuted (ownership was
   persisted in `chrome.storage.session`).
10. **Closed tabs / races** – Rapidly open and close matching tabs and
    navigate quickly between matching and non-matching pages; the service
    worker console should show no uncaught errors.
11. **Unsupported pages** – Open the popup on `chrome://extensions` or the New
    Tab page → it explains the page is unsupported and disables "Add this
    domain" and "Mute tab".
12. **Popup add domain** – On `https://news.example.org/a/b` click "Add this
    domain to mute rules" → a rule `news.example.org` (no subdomains) is
    created and the tab is muted; the button then shows "This domain is
    already a rule".
13. **Validation** – In Options try `example.com/path` (domain) → error;
    `example.com` (URL prefix) → error; add the same rule twice → "An
    equivalent rule already exists" and no duplicate is created.
14. **Default rules** – On a fresh install (remove and re-add the extension),
    Options lists `youtube.com`, `x.com`, `facebook.com`, `threads.com` and
    `instagram.com` as "domain + subdomains"; opening `https://www.youtube.com`
    mutes the tab. Delete one, reload the extension → it is not re-added.

## Rule-matching semantics

A tab is muted automatically when automatic muting is on **and** its URL
matches **any** enabled rule. Only `http:` and `https:` URLs are considered;
every other scheme (`chrome:`, `file:`, `about:`, `data:`, extension pages, …)
is skipped. Matching uses `new URL()` parsing, never substring checks on the
raw URL.

### Domain rules

- Stored as a normalized hostname: trimmed, lowercased, trailing dots removed,
  internationalized names converted to punycode (`bücher.de` →
  `xn--bcher-kva.de`).
- Pasting a full `http(s)://` URL is allowed; its hostname is extracted and
  the normalized value is shown before saving. The URL's port, path, query and
  fragment are ignored (domain rules match any port); URLs containing a
  username or password are rejected.
- Rejected: a hostname followed by a path/query/fragment without a scheme
  (`example.com/news`), a bare `host:port`, credentials, spaces, wildcards (`*.example.com`
  – use "Include subdomains" instead), empty labels, IPv6 literals and non-HTTP
  schemes.
- `example.com` matches only the host `example.com` (any scheme among
  http/https, any port, any path).
- With **Include subdomains**, it also matches hosts whose trailing labels are
  exactly `example.com` (`www.example.com`, `a.b.example.com`). Comparison is
  label by label, so `notexample.com` and `example.com.evil.test` never match.

### URL-prefix rules

- Must be a complete `http://` or `https://` URL. Stored as
  `origin + pathname`; the query string and fragment are removed (the UI says
  so). Default ports are normalized (`https://x.test:443/a` → `https://x.test/a`).
- A tab matches when its scheme, host and port are **exactly** equal to the
  rule's, and its pathname starts with the rule's pathname. The pathname
  comparison is case-sensitive; the host is not (URLs lowercase hosts).
- Query strings and fragments of the tab URL are ignored.
- `https://example.com/news` matches `/news`, `/news/123` and `/newsletter`.
  Enter `https://example.com/news/` to match only that directory.

### Duplicates

Two rules are equivalent when they have the same type and normalized value
(and, for domain rules, the same "Include subdomains" setting). Saving an
equivalent rule shows a message instead of creating it.

## Ownership and manual overrides

- Session state per tab (`chrome.storage.session`, key `tab:<id>`) records
  whether **this extension automatically** muted the tab and any active
  override. It is removed when the tab closes.
- Audio is restored automatically only if the state says the mute was
  automatic **and** `tab.mutedInfo` still reports
  `{ reason: "extension", extensionId: <Hush Rules> }`. This applies when
  leaving a matching URL, disabling/deleting a rule and turning automatic
  muting off. A tab that was already muted is never claimed.
- Popup "Mute tab" / "Unmute tab" sets a manual override bound to the current
  main-frame `documentId`. Automatic rules do not touch the tab while the
  override is active. It survives same-document (SPA) navigation and is
  cleared when a new document commits (navigation or reload) or the tab
  shows an unsupported page. A manual mute
  is never treated as an automatic one, so turning automatic muting off does
  not undo it.
- If the user (tab strip) or another extension changes the mute state, Hush
  Rules gives up ownership and records the same kind of document-scoped
  override, so it does not immediately revert that change. This also happens
  when an evaluation notices that an automatic mute no longer belongs to Hush
  Rules before the corresponding change event has been processed.
- Loop prevention: `mutedInfo` change events caused by Hush Rules itself are
  ignored by the change handler.

## Permissions

| Permission      | Why                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`          | Read tab URLs in the background to match rules, and mute/unmute tabs. Without it `tab.url` is not available.                                                                                                                                                                                                  |
| `storage`       | Persist rules and the global toggle in `chrome.storage.local`; keep per-tab runtime state in `chrome.storage.session` so it survives service worker restarts.                                                                                                                                                  |
| `webNavigation` | `tabs.onUpdated` reports SPA URL changes, but it cannot tell a same-document navigation from a new document or a reload. The manual-override rules require that distinction, so Hush Rules uses `webNavigation.onCommitted` (new document) and the main-frame `documentId`. This permission shows the same "Read your browsing history" install warning that `tabs` already shows, so it adds no new warning. |

Not requested: `<all_urls>` or any host permissions, `scripting`,
`tabCapture`, microphone, content scripts. No network requests, analytics,
remote code or CDNs. All UI text is inserted with `textContent` /
`createElement`; user input never goes through `innerHTML`.

## Assumptions

- Automatic muting is **on** by default after installation, and these
  domain rules (with "Include subdomains" on) are created on first install:
  `youtube.com`, `x.com`, `facebook.com`, `threads.com`, `instagram.com`.
  Subdomains are included so `www.`/`m.` hosts match; this also covers e.g.
  `music.youtube.com`. They are normal rules: disable, edit or delete them in
  Options. Defaults are only added on a fresh install when no rule list has
  been saved yet, so deleting them is permanent and updates never re-add them.
- Overrides recorded when the `documentId` could not be read are kept until
  the next main-frame commit.
- A URL is "usable" as soon as Chrome reports the committed `tab.url`.
  Muting happens at that point; it does not wait for `audible`. The
  not-yet-committed `tab.pendingUrl` is deliberately not used: the
  navigation may still be cancelled, and mute/unmute actions taken before
  commit belong to the previous document.
- Rules are edited by read-modify-write on `chrome.storage.local`. Saving from
  the popup and the options page at the very same instant could lose one of
  the two writes.
- `pnpm` is used in examples; plain `npm` works with the same scripts.

## Known limitations

- **Brief audio leak:** muting is applied by the background service worker
  after Chrome reports the tab's URL. Audio that starts at the very beginning
  of a page load may be audible for a short moment. Silent initial loads are
  not guaranteed.
- Only http(s) pages are handled; IPv6 literal hosts are not supported in
  domain rules (URL-prefix rules accept them).
- No regular expressions, rule ordering, exceptions or sync (by design for
  v1).
- If a tab is still muted after a browser restart, Hush Rules does not claim
  that mute (session state is cleared on restart), so such tabs are left as
  they are.
- Behavior was verified with unit tests and a fake browser only; see
  "Manual acceptance steps" for what must be checked in real Chrome.
