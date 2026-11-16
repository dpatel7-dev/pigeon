# 🕊 pigeon

**Your own locked drive, and files that fly between your devices.**

pigeon is a Google-Drive-style home for your files that lives on a website you
own: folders, stars, search, previews, a trash with undo, share links. On top of
that it moves things between your devices fast: send a project folder from your
laptop straight to another computer, or a photo from your phone straight to your
laptop, and it lands there by itself. Every file is locked (AES-256-GCM) on the
device that sends it. The website only stores scrambled bytes and doesn't even
know your files' or folders' names.

```
  [Coo]  pigeon  v2.0.0                                dhruv · djp7.pythonanywhere.com
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
| Let a friend in | `pigeon invite` (or Invite someone in the browser) gives a code for one new nest of their own |

Deleting moves things to the **trash** (30 days, and **u** / Undo puts them back).
Project folders sent from the terminal travel as one bundle and skip what's big
and easy to get back (`node_modules`, `.git`, `__pycache__`, `.venv`, `.next`, `target`…).
Downloads go to the folder you're in (or `~/Downloads` when you're in your home folder)
and never overwrite. Big files go up and down three 4 MB pieces at a time.

All the commands: `pigeon help`.

## How the locking works

- Your password is stretched (PBKDF2-SHA256, 310,000 rounds) into two keys. One proves
  to the website that it's you; the other locks your files and **never leaves your device**.
- Every file gets its own random key. The file, its name and type are locked with it in 4 MB
  pieces; that key is locked with yours. The website stores locked pieces and nothing else.
- A share link carries the file's key after the `#`. Browsers never send that part to the
  website, so even the links can't be opened by the site itself.
- The web page does exactly the same with your browser's built-in WebCrypto, so things sent
  from your phone open on your laptop and the other way round.

Forget the password and the files can't be opened by anyone — including you. Pick one you'll remember.

## Running the website

The server is one Python file with nothing to install: `server/pigeon_server.py`. It's part of
the [project-site](https://github.com/dpatel7-dev/project-site), next to gossip. To try it locally:

```sh
python3 server/pigeon_server.py --port 8080      # then: pigeon site http://127.0.0.1:8080
```

Settings live in `~/pigeon-data/config.json`:

```json
{ "signups": "first", "quota_mb": 400, "max_file_mb": 400 }
```

`signups`: `"first"` (default) lets exactly one nest be made — yours — and then closes the
door; `"open"` lets anyone make one; `"closed"` lets no one. `quota_mb` is the total space
(PythonAnywhere's free plan has 512 MB for everything).

## Part of a family

- [gossip](https://github.com/dpatel7-dev/gossip) — end-to-end encrypted terminal chat
- [Tree of Thought](https://github.com/dpatel7-dev/Tree-Of-Thought) — many AI models in one terminal garden
- [Project CLI Access](https://github.com/dpatel7-dev/Project-CLI-Access) — one command to open them all

Development: `npm test` (Node 18+, Python 3; no dependencies).
