# DataShelf

A private, password-protected infinite canvas for messy thinking. Multiple
vaults, each with multiple canvases, each canvas holding text cards, images,
audio notes, freehand drawings, links, frames, and arrows connecting them —
locked behind real encryption, autosaved, local-first.

## Running it right now (30 seconds, no build tools needed)

Zero build step — plain HTML/CSS/JS using only browser-native APIs (Web
Crypto, IndexedDB, MediaRecorder). Any static file server works:

```bash
cd DataShelf
python3 -m http.server 8000
# open http://localhost:8000
```

You'll land on a vault picker. Create your first vault (give it a name and
password), and you're in.

## Live deployment

DataShelf is deployed on Render and is available here:

**[Open the live DataShelf app](https://datashelf-uhu7.onrender.com)**

The deployment serves the same static frontend as the local version. Vaults
are encrypted and stored in the browser's IndexedDB, so data created on the
deployed origin is separate from data created at `localhost`. Use the
encrypted **Export** action to move a vault between browsers or environments.

## What's new since v1

Everything below was added on top of the original MVP:

| Feature | What it does |
|---|---|
| **Auto-lock** | Re-locks automatically after 5 minutes of no mouse/keyboard activity |
| **Card colors** | Small color-swatch button on each card, cycles through 5 presets |
| **Pinned cards** | Star a card; a panel in the corner lists pins and jumps the view to them |
| **Snap & align guides** | Dragging a card snaps to nearby edges of other cards, with a pink guide line |
| **Minimap** | Appears once a canvas has 8+ objects; click/drag it to jump around |
| **Markdown-lite** | `**bold**`, `*italic*`, `` `code` ``, and `- [ ]` checkboxes in text cards — click a checkbox without entering edit mode |
| **Encrypted export/import** | Download a vault as an encrypted `.json` backup; import it back in (still needs the original password to open) |
| **Frames** | A loose dashed rectangle — drag it and every card whose center is inside comes with it |
| **Indexed search** | Search now queries a real word index instead of scanning rendered DOM text |
| **Multiple canvases** | Tabs above the canvas — separate boards inside one vault |
| **Multiple vaults** | The app opens to a vault picker; each vault has its own name, password, and encryption key |
| **Graph auto-layout** | One button runs a force-directed layout pass on cards connected by arrows |
| **Audio notes** | Record a voice memo straight onto the canvas |
| **Connection suggestions** | Opt-in, local-only heuristic (word overlap between your notes) that suggests pairs to connect — nothing leaves your device, nothing is auto-created without you clicking "Connect" |

## How the encrypted download/upload works

This directly answers "where's my data and can I move it": your data lives
in the browser's IndexedDB, scoped per-origin (per port, per browser — see
Architecture below). **Export** takes exactly what's already encrypted on
disk — the same PBKDF2+AES-256-GCM ciphertext your vault is stored as — and
wraps it in a small JSON envelope you can download and keep anywhere (a
drive, another machine, cold storage). Nothing is decrypted or re-encrypted
for export; the file on your disk is exactly as protected as the vault
itself. **Import** reads that file back in as a brand-new vault entry in
IndexedDB — it does **not** bypass the password. You unlock it the normal
way, with whatever password it was created under. If you import the same
backup on another machine or browser, you now have that vault there too,
independently.

## Architecture

### Multiple vaults, multiple canvases

```
IndexedDB (one object store, "vault-db")
├── "__index__"        → [{ id, name }, ...]   (labels only, never contents)
├── "vault:<id-1>"      → { salt, iterations, verifierIv/Ciphertext, dataIv/Ciphertext }
└── "vault:<id-2>"      → { ... }

Each vault's decrypted payload:
{
  canvases: {
    "c1": { objects: {...}, nextZ: N, _name: "Ideas" },
    "c2": { objects: {...}, nextZ: N, _name: "Q3 plan" }
  },
  activeCanvasId: "c1",
  nextCanvasN: 3
}
```

The vault index (names + ids) is the only thing readable without a
password — by design, this is a local single-user app, so a human-chosen
label being visible on the picker screen is an acceptable tradeoff for
"which vault do I want to unlock" being usable at all. Nothing about a
vault's *contents* is ever readable without its key.

`frontend/js/canvas.js` only ever knows about **one** canvas's objects at a time —
it has no idea vaults or multiple canvases exist. `frontend/js/app.js` owns the
vault-level structure and swaps canvases in and out of `frontend/js/canvas.js` via
`loadState()`/`getState()` when you click a tab. That separation is why
adding "multiple canvases" didn't require touching a single line of the
actual canvas engine.

### Data model

```
{ id, type, x, y, w, h, z, createdAt, updatedAt, data }
type ∈ 'text' | 'image' | 'drawing' | 'link' | 'arrow' | 'frame' | 'audio'
```
- `text.data`: `{ title, body, color, pinned }` — `body` is raw markdown-lite source; rendered on blur, edited as plain text on click.
- `frame.data`: `{ title, color }` — no `fromId/toId`; frames group by *position*, computed fresh each drag, not by a stored membership list. That means moving a card in or out of a frame's boundary changes whether it's "in the group" next time you drag the frame — deliberately simple, no hidden group state to get out of sync.
- `arrow.data`: `{ fromId, toId }` — recomputed from both endpoints' *current* position every render, so connections survive drags without tracking offsets.
- `audio.data`: `{ src }` — a base64 `data:` URL of the recorded clip.

### Security (unchanged from v1, still worth restating)

```
password → PBKDF2-HMAC-SHA256, 600,000 iterations, random 16-byte salt
         → 256-bit AES key (non-extractable)
         → AES-256-GCM, random 96-bit IV per encryption
         → ciphertext stored in IndexedDB (or in an exported backup file)
```
Every vault has its own independent salt and key — unlocking one tells you
nothing about another, even if you reuse a password across them. The
derived key lives only in memory for the unlocked session and is discarded
on lock. Wrong passwords fail via the AES-GCM authentication tag, not a
custom check.

### Suggestions are a local heuristic, not AI

"Suggest connections" tokenizes your card text and computes word overlap
(Jaccard similarity) between pairs that aren't already connected. That's
it — no network call, no external model, nothing about your notes ever
leaves the browser for this feature. It's opt-in (you click the button),
every suggestion needs your explicit "Connect" click, and dismissed
suggestions are just forgotten, not tracked. I built it this way
specifically so it can't quietly graduate into something that reads your
private thoughts on a server somewhere.

## Controls

| Action | Input |
|---|---|
| Create a text card | Double-click empty canvas, or **+ Idea** |
| Move / resize | Drag it / drag its corner handle |
| Cycle a card's color | Click the small dot in its header |
| Pin / unpin | Click the star in its header |
| Edit markdown text | Click the rendered body; blur to re-render |
| Toggle a checkbox | Click it directly — doesn't enter edit mode |
| Group-drag | Drag a **Frame** — anything centered inside comes with it |
| Multi-select | Rubber-band drag, or Shift-click |
| Select all / Delete | `Ctrl/Cmd+A` / `Delete` |
| Pan | Space + drag, or two-finger trackpad scroll |
| Zoom | `Ctrl/Cmd` + scroll, or pinch |
| Undo / Redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Connect two cards | **↗ Connect**, then click both in order |
| Draw freehand | **✏ Draw** |
| Record a voice note | **🎙 Rec** (click again to stop) |
| Auto-arrange connected cards | **◈ Graph** |
| Suggest connections | **✨ Suggest** (local only, opt-in) |
| Switch / add / rename / delete a canvas | Tabs bar — click / **+** / double-click / **×** |
| Search | Type in the search box |
| Download an encrypted backup | **⬇ Export** |
| Load a backup | **⬆ Import** (still needs its original password) |
| Jump to a pinned card | Click it in the pin panel |
| Pan via overview | Click/drag the minimap (appears past ~8 cards) |

## Testing performed

Same principle as before: I don't have a browser here, so I ran the real
code against real implementations of the APIs it depends on rather than
eyeballing it.

**27 end-to-end assertions**, driving the actual `frontend/index.html`/`frontend/js/app.js`
through a real DOM (`jsdom`) and a real IndexedDB (`fake-indexeddb`):
create a vault → add a text/link/frame card → cycle its color → pin it →
edit its markdown body → confirm bold/code/checkbox actually render →
confirm the search index finds it → confirm the connection-suggestion
heuristic surfaces genuinely overlapping cards → add a second canvas and
switch between them → connect two cards and run graph auto-layout →
autosave → export → lock → back to the vault picker → unlock → **confirm
color, pin, and both canvases survived** → take the exported record,
import it as a brand-new vault, decrypt it with the original password, and
confirm the content (including that same color and pin) matches — then
confirm a wrong password still fails against that imported copy.

That process caught a real, meaningful bug: `updateObject()` used
`Object.assign(obj, patch)` which — because `data` is a nested object —
silently replaced a card's *entire* `data` field with whatever the current
patch contained, before a later line tried (too late) to merge it back.
In practice this meant coloring or pinning a card, then later editing its
text, would silently erase the color/pin. Fixed by pulling `data` out of
the patch and merging it separately from the rest.

**Not** driven through simulated execution here (reviewed, not run):
- Audio recording (`MediaRecorder`/`getUserMedia` don't exist outside a real browser)
- Snap-to-grid guides and frame group-dragging, which depend on real mouse-drag sequences over actual laid-out DOM elements
- The 5-minute auto-lock timer firing (the interval-check logic is simple and reviewed; I didn't sit through a real 5 minutes)
- The Tauri native shell (no display server or Rust toolchain in this environment — see below)

Please exercise those by hand and tell me if anything's off.

## Turning it into a native desktop app (Tauri)

Same as before — `src-tauri/` is a scaffold, unverified in this sandbox:

```bash
npm install
npm run tauri dev
npm run tauri build
```

## Known limitations

- **Frame membership is recomputed on every drag**, not stored — a card
  slightly outside a frame's boundary won't move with it. Deliberate
  simplicity tradeoff; a "real" grouping model is a natural next step if
  this ever feels wrong in practice.
- **Snap guides compare against every other object on the canvas** each
  frame of a drag — fine at MVP scale (hundreds of objects), would need
  spatial indexing before thousands.
- **The word-overlap suggestion heuristic is intentionally simple** — it
  won't catch conceptually related notes that don't share literal words.
  That's a reasonable place to stop for a v1 that respects "nothing leaves
  your device."
- **Vault names are visible on the picker screen before authentication**
  (contents are not). Acceptable for a local single-user app; worth
  revisiting if this ever supports a shared or multi-user machine.
- Autosave and undo/redo still snapshot/re-encrypt the whole active
  canvas per change (see v1 limitations) — unchanged, still fine at MVP
  scale.

## What to build next

1. Try the Tauri build on a real machine and iron out any version drift.
2. A "real" export flow that also offers a *re-encrypted* file (new
   password, for sharing a backup with someone else) alongside the current
   "same key" backup.
3. Proper frame membership (stored, not recomputed) if loose grouping ever
   feels unpredictable in practice.
4. OS keychain integration once native, for a "remember this device" flow
   that never stores the password itself.
