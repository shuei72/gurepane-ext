<p align="center">
  <img src="media/icon.png" alt="Gurepane icon" width="128" />
</p>

# Gurepane

Gurepane is a VS Code extension that runs `rg` and shows search results in a quickfix-style tree view inside the panel.

## Features

- Runs ripgrep with a configurable `rg` path or the `rg` available on `PATH`.
- Shows multiple results and lets you switch between them.
- Opens the matched file and jumps to the selected line and column.
- Supports next and previous node navigation commands.
- Highlights matched text using ripgrep's JSON match ranges.
- Can export a top-level result as TSV.

### Folder Prompt

The folder picker opens directly as a search UI.

- Type any part of a folder name or path to search folders
- Press Enter on `Workspace` to search the whole workspace
- If Everything's `es.exe` is available, folder candidates come from Everything instead of local scanning

## Commands

`Search`  
Prompts for a search pattern, then prompts for a target folder, and runs ripgrep.
Plain input is treated as regex with smart case. Use `t>` for literal text if the pattern contains regex characters.

`Switch Result`  
Switches the active top-level result.

`Delete Result`  
Deletes the selected result and all of its nodes.

`Search Again with Same Scope`  
Reuses the current result's folder and filters, then prompts for a new search keyword and runs a fresh search.

`Next Node`  
Moves to the next match in the active result.

`Previous Node`  
Moves to the previous match in the active result.

`Reveal Current Node`  
Reopens the current node for the active result and moves the cursor back to that match.

## Settings

`gurepane.rgPath`  
Absolute path or command name for `rg`. When empty, Gurepane uses `rg` from `PATH`.

`gurepane.esPath`  
Absolute path or command name for `es.exe`. When empty, Gurepane uses `es.exe` from `PATH` to collect folder candidates, and falls back to local folder scanning if it is unavailable.

## Development

### PowerShell

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd run package
npm.cmd run package:vsix
```

### Command Prompt

```cmd
npm install
npm run compile
npm run package
```

## Other

- This extension was created with Codex.

## License

MIT License
