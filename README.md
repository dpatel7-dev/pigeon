# 🕊 pigeon

**Move files between your devices — laptop, phone, anything — locked on the way.**

pigeon keeps files in your **nest** on a website you own, and passes them
between your devices. Send a project folder from your laptop and pull it down
on another. Snap a photo on your phone and it lands on your laptop a second
later. Every file is locked (AES-256-GCM) on the device that sends it — the
website only ever stores scrambled bytes, and doesn't know your files' names.

```
  [Coo]  pigeon  v1.0.0                                dhruv · djp7.pythonanywhere.com
         3 files · 9 MB of 400 MB  ━━──────────
 ───────────────────────────────────────────────────────────────────────────────────
  ›  PNG   IMG_2041.png                          2.1 MB  from iPhone            2m ago
     DIR   my-project/                         340 KB  from MacBook (Mac)     1h ago
     PDF   notes.pdf                             1.2 MB  from MacBook (Mac)     3d ago
 ───────────────────────────────────────────────────────────────────────────────────
  › drop a file or folder here, or type its path (enter sends)
  enter save · l link + QR · c catch from phone · d delete · o open · ? keys · q quit
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

**On your phone** there's nothing to install: open <https://djp7.pythonanywhere.com/pigeon>
and log in with the same nest name and password. (Add it to your home screen for one-tap access.)

## Using it

| | |
| --- | --- |
| Send from the laptop | drop a file or folder onto the pigeon window, or `pigeon send photo.jpg my-project/` |
| Get on the laptop | `pigeon get` (the newest) or `pigeon get notes` — or press Enter on it in `pigeon` |
| Photo from phone → laptop | press **c** in pigeon (or run `pigeon catch`), scan the QR code with your phone, send — it lands on the laptop by itself |
| Laptop → phone | send it, then tap **Save** on the phone page — or press **l** for a QR code and point the phone's camera at it |
| Share with someone | **l** (or `pigeon link notes`): a link + QR code that works for 24 hours, no account needed |

Folders travel as one bundle and skip what's big and easy to get back
(`node_modules`, `.git`, `__pycache__`, `.venv`, `.next`, `target`…). Downloads go to the
folder you're in (or `~/Downloads` when you're in your home folder) and never overwrite.

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
