# Changelog

## 1.0.0
- First release: a nest on your own website, and files that move between your devices locked end to end.
- Terminal app with Coo the pigeon: drop files or folders onto the window to send them, Enter to save, `l` for a share link with a QR code, `c` to catch the next thing from your phone.
- Phone-friendly web page: log in with the same nest name and password, send photos straight from the camera roll, save, preview, share.
- Share links work for 24 hours without an account; the key rides after the `#`, so the website can't open them.
- Folders are bundled for you and skip node_modules, .git and friends.
- Big files go in 4 MB pieces, retried if the connection blips.
- Everything from the shell too: `pigeon send`, `get`, `ls`, `link`, `catch`, `open`, `rm`.
