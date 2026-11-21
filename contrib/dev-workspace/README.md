# Personal developer workspace

A quiet neutral layout for this Mac: Inter UI text, JetBrainsMonoNL Nerd Font
14 px terminals with 1.08 line height, readable status colors, a 252 px sidebar,
smaller pane corners, and closer pane spacing. Both fonts are already installed
on the owner's Mac. Other machines need those fonts or substitutions in dev.json.
System light/dark appearance selects the matching palette. No animation or
blur, no settings.json changes, no session or process changes.

```sh
python3 contrib/dev-workspace/install.py          # preview
python3 contrib/dev-workspace/install.py --apply
herdr-app check ~/.config/herdr-app/mods/dev-tabs
herdr-app do layout.switch --name dev
```

The installer creates personal layout/theme files and a personal tab-bar copy,
backing up changed files. Updates do not replace these copies. Rerun the installer
after updating this fork to refresh the personal tab bar (it makes a backup).
Switch back with `herdr-app do layout.switch --name main`.

The VS Code button opens remote Unix folders through the local VS Code and its
Remote-SSH extension. It looks up Herdr's configured SSH target at click time,
so renaming a machine does not change its connection. Paths are URI encoded,
not concatenated into shell commands. macOS uses the installed application;
Linux/Windows use the standard code/code.cmd launcher.

Select the built-in VS Code editor from the button's right-click menu. Custom
editor commands and connections supplied through `--via` are rejected with a
specific message. Targets with an explicit port should use an SSH config alias
that includes that port. VS Code handles login, host trust and extension/server
setup itself. The button starts the connection; a successful local launch does
not prove remote authentication completed.
