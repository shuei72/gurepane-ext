# Gurepane

Gurepane is a VS Code extension that runs `rg` and shows search results in a quickfix-style tree view inside the panel.

## Features

- Runs ripgrep with a configurable `rg` path or the `rg` available on `PATH`.
- Shows multiple search result sets and lets you switch between them.
- Opens the matched file and jumps to the selected line and column.
- Supports next and previous result navigation commands.
- Highlights matched text using ripgrep's JSON match ranges.
- Can export a top-level search result set as TSV.

## Commands

`Gurepane: Search with Gurepane`  
Prompts for a search pattern, then prompts for a target folder, and runs ripgrep.

`Gurepane: Switch Gurepane Search Result`  
Switches the active top-level search result set.

`Gurepane: Go to Next Gurepane Result`  
Moves to the next match in the active result set.

`Gurepane: Go to Previous Gurepane Result`  
Moves to the previous match in the active result set.

## Folder Prompt Shortcuts

In the folder input after entering the search text:

- Empty input: search the whole workspace
- `. `: insert the current editor's folder path
- `.. `: move one level up from the current input
- `@ `: insert the previous folder path
- `/` or `\\` at the end: open child folder candidates

## Settings

- `gurepane.rgPath`: optional path or command name for `rg`

## Packaging

```powershell
npm.cmd run compile
npm.cmd run package
```

To create a fixed output filename:

```powershell
npm.cmd run package:vsix
```

## License

MIT License
