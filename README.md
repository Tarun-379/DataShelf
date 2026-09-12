# Nexus

A private, password-protected infinite canvas for messy thinking. Text cards,
images, freehand drawings, links, and arrows connecting them — locked behind
real encryption, saved automatically, and kept local-first.

## Running it right now (30 seconds, no build tools needed)

This app has zero build step — it's plain HTML/CSS/JS using only browser-native
APIs (Web Crypto, IndexedDB). Any static file server works:

```bash
cd Nexus
python3 -m http.server 8000
# open http://localhost:8000 in Chrome, Firefox, Safari, or Edge
```

That's it. First launch asks you to create a password; every launch after
that asks you to unlock.

> **Why not just double-click `index.html`?** Browsers restrict some APIs
> (IndexedDB, in some browsers) on `file://` pages. A local server avoids
> that entirely and costs one command.

## Turning it into a native desktop app (Tauri)

The `src-tauri/` folder is a scaffold that wraps this same frontend in a
native window via [Tauri](https://tauri.app) — I could not compile or run
this in the sandbox I built it in (no display server, no Rust toolchain
available), so **treat it as a starting point to verify locally**, not as
tested output. To try it:

```bash
# prerequisites: Rust (rustup.rs) + platform build deps — see
# https://tauri.app/start/prerequisites/
npm install
npm run tauri dev      # dev mode, opens a native window
npm run tauri build     # produces an installable app for your OS
```

If anything doesn't compile out of the box, it's almost certainly a Tauri
version/config mismatch (Tauri's config schema shifts between versions) —
the frontend code itself needs no changes to run natively.

## How it actually works

### Authentication & encryption

```
password → PBKDF2-HMAC-SHA256, 600,000 iterations, random 16-byte salt
         → 256-bit AES key (non-extractable — can't be read back out, even by this code)
         → AES-256-GCM, random 96-bit IV per encryption
         → ciphertext stored in IndexedDB
```

Everything here is a native browser API call (`crypto.subtle`) — there is no
hand-rolled cryptography anywhere in this codebase (`js/crypto.js`).

- **Nothing plaintext ever touches disk.** The IndexedDB record holds only:
  a random salt, an iteration count, an encrypted "verifier" blob, and the
  encrypted vault contents. No password, no key, no readable notes.
- **The derived key lives only in memory** for the unlocked session (a
  closure variable in `js/app.js`), and is discarded the instant you lock
  the vault or close the tab.
- **Wrong passwords fail closed, structurally.** AES-GCM is authenticated
  encryption — decrypting with the wrong key doesn't produce garbled data,
  it throws, because the authentication tag doesn't match. There's no
  custom "is this the right password" check to get subtly wrong.
- I chose **PBKDF2** over Argon2id specifically because it's built natively
  into every browser — no third-party WASM library to audit or trust. If
  you later want Argon2id (stronger against GPU/ASIC attacks), swap
  `deriveKey()` in `js/crypto.js` for a vendored, audited implementation
  (e.g. a WASM build of the reference `argon2` crate) — the rest of the
  architecture (verifier pattern, AES-GCM, key lifecycle) doesn't change.

### Canvas & data model

Every object on the canvas is:
```
{ id, type, x, y, w, h, z, createdAt, updatedAt, data }
```
`type` is one of `text | image | drawing | link | arrow`. Arrows store
`{ fromId, toId }` in `data` and are re-drawn from the *current* position of
both endpoints every render — so connections stay attached as you drag
things around, without needing to track offsets.

Adding a new object type later (code blocks, audio notes, PDFs) means adding
one branch to `renderCard()` in `js/canvas.js` — the CRUD, undo/redo,
autosave, and selection logic is already type-agnostic.

### Persistence

Every mutation (`addObject`, `updateObject`, `deleteObjects`) triggers a
debounced autosave (800ms) that re-encrypts the *entire* canvas state and
writes it to IndexedDB. Simple, and correct for the data sizes this is meant
for; see Known Limitations for where that stops scaling.

### Undo/redo

Each mutation snapshots the full object map onto an undo stack (capped at
100 entries) before applying the change. `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z`
pop from undo/redo respectively. Simple and reliable; see limitations below
for the tradeoff.

## Controls

| Action | Input |
|---|---|
| Create a text card | Double-click empty canvas, or the **+ Idea** button |
| Move an object | Drag it |
| Resize | Drag its bottom-right corner handle |
| Multi-select | Drag a rubber-band over empty canvas, or Shift-click |
| Select all | `Ctrl/Cmd + A` |
| Delete selection | `Delete` / `Backspace` |
| Pan | Space + drag, or two-finger trackpad scroll / mouse wheel |
| Zoom | `Ctrl/Cmd` + scroll, or pinch on a trackpad |
| Undo / Redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Deselect / cancel a tool | `Escape` |
| Connect two cards | **↗ Connect** button, then click the two cards in order |
| Draw freehand | **✏ Draw** button, then draw with the mouse/pen |
| Add an image | **+ Image** button, or drag-and-drop a file onto the canvas |
| Add a link | **+ Link** button |
| Search | Type in the search box — matching cards stay bright, others dim |

## Project structure

```
Nexus/
├── index.html          entry point, lock screen + app shell markup
├── css/style.css        dark/minimal theme
├── js/
│   ├── crypto.js         PBKDF2 + AES-256-GCM via Web Crypto (no custom crypto)
│   ├── storage.js        IndexedDB wrapper — one encrypted record
│   ├── canvas.js         infinite canvas engine: objects, pan/zoom, undo/redo
│   └── app.js            auth flow, toolbar wiring, autosave orchestration
├── src-tauri/            native-shell scaffold (untested here — see above)
└── package.json          only needed for the Tauri CLI
```

## Testing performed

I don't have a browser in the environment I built this in, so I couldn't
visually verify it — but I didn't just eyeball the code and hope. I ran it
for real:

- `crypto.js`: round-tripped actual encrypt/decrypt through Node's Web
  Crypto implementation (the same API browsers use), and confirmed a wrong
  password is rejected by the AES-GCM auth tag, not a hand-written check.
- `storage.js`: exercised against a real IndexedDB implementation
  (`fake-indexeddb`) — put/get/erase all round-trip correctly.
- `canvas.js`: driven through a real DOM (`jsdom`) — object creation,
  move, resize, delete, undo, redo, and arrow cleanup-on-delete all verified
  against actual state, not assumed.
- **Full integration**: loaded the real `index.html` end-to-end (create
  vault → add a card → autosave → lock → wrong password rejected → correct
  password unlocks → card is still there → repeat) through 14 assertions,
  all passing against the actual code paths.

That process caught two real bugs before you ever saw this code: `enterVault`
was calling `loadState()` (which renders) before `init()` (which creates the
DOM nodes render() writes into) — first unlock would have crashed instantly.
And re-locking after creating a vault showed the "create a new vault" screen
again instead of "unlock," because that toggle only ran once at page load.
Both are fixed and covered by the integration test above.

What I *can't* verify from here: how it actually feels to use — cursor
behavior, animation smoothness, whether the pan/zoom conventions feel right
on your trackpad. Please try it and tell me what's off.

## Known limitations (v1)

- **Autosave re-encrypts the whole canvas on every change.** Fine for
  hundreds of objects; will get sluggish with thousands, especially with
  many embedded images (each image is stored as a base64 data URL inside
  the encrypted blob). A future version should store images as separate
  encrypted blobs referenced by ID.
- **Undo/redo snapshots the whole object map.** Same tradeoff — simple and
  correct, not the most memory-efficient at large scale.
- **No full-text search index** — search is a simple substring match over
  currently-rendered card text, not indexed, so it only searches what's on
  screen logic-wise (all cards are always in the DOM, so this is currently
  equivalent to full search, but it's not architected as a real index).
- **Single vault, single canvas.** The data model doesn't prevent adding
  more, but v1 only builds one.
- **No encrypted export/import yet.** Your only copy is the browser's
  IndexedDB for that profile — back up that browser profile if you care
  about it, until export lands.
- **The Tauri wrapper is unverified** — see above.

## What to build next

Roughly in the order I'd tackle it:
1. Verify and fix up the Tauri build on your machine (real display, real
   Rust toolchain, both of which I lack here).
2. Encrypted export/import (a single encrypted file you can back up or
   move between machines).
3. Move images to separate stored blobs instead of inline data URLs.
4. Optional OS keychain integration once native (store a "remember this
   device" flag, never the password itself).
5. Full-text search index, tags, multiple canvases — in that rough order,
   matching the "future-ready but don't build yet" list from the spec.
