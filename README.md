# pigeon

**Your own locked drive, and files that fly between your devices.**

pigeon is a Google-Drive-style home for your files that lives on a website you
own: folders, stars, search, previews, a trash with undo, share links. On top of
that it moves things between your devices fast: send a project folder from your
laptop straight to another computer, or a photo from your phone straight to your
laptop, and it lands there by itself. Every file is locked (AES-256-GCM) on the
device that sends it, and every request travels sealed. The website only stores
scrambled bytes and doesn't even know your files' or folders' names.

New in pigeon 3: free extra storage (barns), squeezing, no doubles, Rewind
(old versions), drop boxes, landing by itself in the background, and a
developer console for whoever runs the site.

```
  [Coo]  pigeon  v3.0.0                                dhruv · djp7.pythonanywhere.com
         12 files · 9 MB of 400 MB  ━━──────────
 ───────────────────────────────────────────────────────────────────────────────────
  My nest › Projects
  ›  ▤     game/                                          4 files
     PNG   IMG_2041.png  ★                     2.1 MB  from iPhone            2m ago
     DIR   my-project/                         340 KB  from MacBook           1h ago
 ───────────────────────────────────────────────────────────────────────────────────
  › drop files here to send them into Projects, or type a path
  enter open · ← back · l link · p send to device · n folder · r rename · m move · d delete
```

## Install (laptop)

macOS and Linux:

```sh
curl -fsSL https://djp7.pythonanywhere.com/pigeon/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://djp7.pythonanywhere.com/pigeon/install.ps1 | iex
```

Then run `pigeon` and make your nest: pick a name and a password. That's it.

### Ways to open your nest

It's the same nest and the same page every way. If one doesn't work for you, use another.

| Way | Type this in Terminal | Good for |
| --- | --- | --- |
| The website | (nothing: open <https://djp7.pythonanywhere.com/pigeon>) | any computer, nothing to install |
| Signed in, from your computer | `pigeon dashboard` | saving files straight into Downloads |
| A window of its own | `pigeon app` | using pigeon like an app |
| Your own pigeon, at home | `pigeon home` | when the website is down or blocked: your drive lives on your computer |
| The terminal | `pigeon` | arrow keys and Enter, drag files onto the window |

`pigeon home` needs Python 3 (on a Mac, `xcode-select --install` adds it). Add `--wifi` so pigeon on
your other computers can use it too (they type the `pigeon site …` line it shows).

**In a browser** there's nothing to install: open <https://djp7.pythonanywhere.com/pigeon>
and sign in with the same nest name and password. On a computer that has pigeon,
`pigeon dashboard` opens the same page already signed in, and Save writes straight
into a folder there.

## Using it

| | |
| --- | --- |
| Keep files | drop them onto the pigeon window or the web page; make folders with **n** (terminal) or **New** (browser) |
| Organise | rename (**r**), move (**m** or drag onto a folder in the browser), star (**\***), search (browser) |
| Send to another device | **p** in pigeon, "Send to a device…" in the browser, or `pigeon send pic.png --to iPhone`: it saves itself there the next time pigeon is open on it |
| Get on the laptop | Enter on it in `pigeon`, or `pigeon get notes` |
| Photo from phone → laptop | press **c** in pigeon (or `pigeon catch`), scan the QR code with your phone, send: it lands on the laptop by itself |
| A copy in a folder | `pigeon sync` keeps `~/Pigeon` matched with your nest (add `--watch` to keep going) |
| Share with someone | **l** (or `pigeon link notes`): a link + QR code that works for 24 hours, no account needed |
| Get files from someone | a drop box: `pigeon box new "Homework"` (or Drop boxes in the browser) makes a link anyone can send you files through |
| Old versions | send a file with the same name to the same folder and the old one is kept: **v** in pigeon, `pigeon rewind essay.md`, or right-click › Versions |
| Text or a link to another device | `pigeon text "https://…"` or `pigeon clip` (what you copied): it lands on that device's clipboard |
| Let a friend in | they just make their own nest (a new name and password): no code needed, and you can't see inside each other's |

### Sending to your other devices

`pigeon send photo.jpg --to iPhone` (or `--to all`) sends something straight to another device.
It lands by itself the next time pigeon is open there, or right away if pigeon is **roosting**:

```sh
pigeon roost on      # Mac: land things in the background, every time you log in
pigeon rules         # where they go: photos in Pictures, PDFs in Documents, text on the clipboard…
pigeon sent          # what you sent, and where it landed
```

Add `--open` to open it when it lands (photos, PDFs, text: never apps or scripts), `--drop` so it
isn't kept in your nest, `--expires 2d` to give up if it isn't collected.

Deleting moves things to the **trash** (30 days, and **u** / Undo puts them back).
Project folders sent from the terminal travel as one bundle and skip what's big
and easy to get back (`node_modules`, `.git`, `__pycache__`, `.venv`, `.next`, `target`…).
Downloads go to the folder you're in (or `~/Downloads` when you're in your home folder)
and never overwrite. Big files go up and down three 4 MB pieces at a time.

All the commands: `pigeon help`.

## How the locking works

pigeon 3 locks two things: your files (below), and every request about them.

- **Requests are sealed.** Your device and your site agree on fresh keys with a Diffie-Hellman
  handshake (the 2048-bit group from RFC 3526); the site's half is remembered the first time, like
  SSH. Every request then goes to one address (`/api/w`) as one scrambled blob (HMAC-SHA256 in
  counter mode, sealed with HMAC-SHA256): what you asked, your sign-in, which file. Each carries a
  fresh random number and the time, so it can't be played back. Anything that opens HTTPS along the
  way, or keeps logs, sees sizes and times only. Device names are locked with your key too.

- Your password is stretched (PBKDF2-SHA256, 310,000 rounds) into two keys. One proves
  to the website that it's you; the other locks your files and **never leaves your device**.
- Every file gets its own random key. The file, its name and type are locked with it in 4 MB
  pieces; that key is locked with yours. The website stores locked pieces and nothing else.
- A share link carries the file's key after the `#`. Browsers never send that part to the
  website, so even the links can't be opened by the site itself.
- The web page does exactly the same with your browser's built-in WebCrypto, so things sent
  from your phone open on your laptop and the other way round.
- **Squeezing:** before a piece is locked it's deflated, if that makes it smaller (photos and zips are
  left as they are). Locked bytes can't be squeezed, so this has to happen first.
- **No doubles:** each file gets a fingerprint keyed with your password. If your nest already has the
  same bytes, nothing is uploaded. The site can only tell that two of *your* files match.
- **Drop boxes:** a box has its own key pair (ECDH P-256). Someone sending you a file locks it with the
  box's public key in their browser; only your devices hold the private half (locked with your key).

Forget the password and the files can't be opened by anyone — including you. Pick one you'll remember.

## Running the website

The server is one Python file with nothing to install: `server/pigeon_server.py`. It's part of
the [project-site](https://github.com/dpatel7-dev/project-site), next to gossip. To try it locally:

```sh
python3 server/pigeon_server.py --port 8080      # then: pigeon site http://127.0.0.1:8080
```

Settings live in `~/pigeon-data/config.json`:

```json
{ "signups": "open", "quota_mb": 400, "nest_mb": 100, "max_file_mb": 400 }
```

`signups`: `"open"` (default) lets anyone make a nest; `"closed"` lets no one new in.
The first nest made on a site is its owner (yours).

### Space

- `quota_mb` is the total for everyone's files together. pigeon never goes past it, so the
  site itself can't run out of disk (PythonAnywhere's free plan has 512 MB for everything).
- `nest_mb` is each nest's own share, so one person can't fill the site for everyone.
  Your own nest can use all of `quota_mb`.
- As the owner, open **your name → People and space** in the browser: see how much each nest
  uses (never what's in it), give a nest more room, or remove one you don't recognise.
- When the site is over 90% full, the trash empties after 3 days instead of 30.
- Sending to a device as a drop-off doesn't keep anything: it's deleted once it arrives.

### Much more room: storage barns

A barn is a free bucket that holds the locked pieces instead of the site's own disk:

| | Free | You need |
| --- | --- | --- |
| Backblaze B2 | 10 GB | an email, and a phone that can get one text message to turn B2 on (a parent's works). No card. |
| Cloudflare R2 | 10 GB a month | an email, and a payment method on the account. pigeon keeps a barn under 10 GB, so nothing is charged. |

1. `pigeon barn guide` shows every click to make the bucket and its key.
2. `pigeon barn add` asks for the endpoint, bucket name and key, then sets the bucket up (it tells the
   bucket browsers may use it) and tests it with a tiny file.
3. New files go to whichever place has the most room. `pigeon barn ls` shows them all.

Your devices send pieces straight to the bucket; the site only signs URLs that work for one piece, for
an hour (AWS Signature Version 4), so it never needs to reach the bucket itself. That matters on
PythonAnywhere's free plan, which can't. The bucket only ever sees scrambled pieces.
You can also add a barn in the browser (People and space › Room), then finish with `pigeon barn fix`.

### The developer console

Set a password in **People and space › Developer console** (or `pigeon console --set`). Then:

```sh
pigeon console            # live: every request, how long it took, every error with its traceback
```

or open `https://your-site/pigeon/console`. It shows what was asked (after unsealing), never what's in
anyone's files, and cuts addresses short. The log is kept to about 2 MB.

## Part of a family

- [gossip](https://github.com/dpatel7-dev/gossip) — end-to-end encrypted terminal chat
- [Tree of Thought](https://github.com/dpatel7-dev/Tree-Of-Thought) — many AI models in one terminal garden
- [Project CLI Access](https://github.com/dpatel7-dev/Project-CLI-Access) — one command to open them all

Development: `npm test` (Node 18+, Python 3; no dependencies).
