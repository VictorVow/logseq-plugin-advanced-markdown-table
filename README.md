# Logseq Advanced Markdown Table Editor

An advanced markdown table editor for [Logseq](https://logseq.com). Blocks whose content is a markdown table are rendered as a real, editable table — click a cell to edit, use the toolbar / right-click menu / keyboard shortcuts to add, move, delete or sort rows and columns. The block's raw markdown stays the source of truth.

English | [简体中文](./README-zh_CN.md)

![demo](./demo.gif)

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Notes & limitations](#notes--limitations)
- [Development](#development)
- [License](#license)

## Features

- **Inline editing** — markdown-table blocks render as a live, contenteditable table directly in the Logseq outliner. No modal, no separate panel.
- **Toolbar & context menu** — pinned toolbar above the focused table (toggleable) plus a right-click menu, both offering insert / move / delete / sort actions.
- **Maximise** — expand the table to fill the Logseq window for editing wide data, then collapse it back.
- **Sort columns** ascending or descending.
- **Drag-to-reorder** rows and columns from the table's top/left edge.
- **Slash command** to insert a starter table at the caret.
- **Keyboard-first editing** — every structural operation has a default keybinding, all rebindable from Logseq's Keymap UI.
- **Monospace source view** — when you drop into the raw markdown, the textarea switches to a monospace font so aligned tables actually line up.

## Installation

### From the Logseq marketplace

1. In Logseq, open **Settings → Features** and enable **Plug-in system**.
2. Click the **Marketplace** icon in the top-right plugin bar.
3. Search for _Advanced Markdown Table Editor_ and click **Install**.

### Manual install (unpacked)

1. Download the latest `.zip` from the [Releases](https://github.com/VictorVow/logseq-plugin-markdown-table/releases) page and extract it.
2. In Logseq, open **Settings → Plugins → Load unpacked plugin** and select the extracted folder.

### From source

```shell
git clone https://github.com/VictorVow/logseq-plugin-markdown-table
cd logseq-plugin-markdown-table
npm install
npm run build
```

Then load the project folder via **Load unpacked plugin** in Logseq.

## Usage

- **Insert a table**: type `/Markdown Table Editor` in any block — a minimal 1×1 table is inserted and focus drops into the header cell.
- **Edit a cell**: click any cell and type. Changes are debounced and written back to the block's markdown automatically.
- **Reorganise structure**: use the keyboard shortcuts below, the pinned toolbar above the focused table, or right-click for the full menu.
- **Maximise**: click the maximise button in the toolbar (or the menu entry) to expand the table to the full Logseq window; `Esc` exits.
- **Drag to reorder**: hover the table's top edge to grab a column, or the left edge to grab a row, then drag.

## Keyboard shortcuts

The shortcuts below are scoped to a focused table cell — they don't fire when your caret is in a regular Logseq block, so they won't collide with Logseq's native chords (`Alt+Shift+Up` still moves the block, `Ctrl+Backspace` still deletes a word, etc.). The commands are also registered with Logseq (without a default global binding) so you can assign your own global hotkeys from **Settings → Keymap** (search for _Markdown table_). The in-cell defaults are:

### Caret navigation (inside a cell)

| Action                   | Default                            |
| ------------------------ | ---------------------------------- |
| Move caret to cell below | `Ctrl+Alt+Down` / `Ctrl+Enter`     |
| Move caret to cell above | `Ctrl+Alt+Up` / `Ctrl+Shift+Enter` |
| Move caret to cell left  | `Ctrl+Alt+Left`                    |
| Move caret to cell right | `Ctrl+Alt+Right`                   |

`Tab` and `Shift+Tab` also move focus to the next / previous cell. These use the browser's native focus traversal (each cell is a tab stop), so they aren't registered as Logseq commands and can't be rebound from the Keymap UI.

### Insert rows & columns

| Action              | Default                |
| ------------------- | ---------------------- |
| Insert row below    | `Ctrl+Alt+Shift+Down`  |
| Insert row above    | `Ctrl+Alt+Shift+Up`    |
| Insert column right | `Ctrl+Alt+Shift+Right` |
| Insert column left  | `Ctrl+Alt+Shift+Left`  |

### Move rows & columns

| Action            | Default           |
| ----------------- | ----------------- |
| Move row up       | `Alt+Shift+Up`    |
| Move row down     | `Alt+Shift+Down`  |
| Move column left  | `Alt+Shift+Left`  |
| Move column right | `Alt+Shift+Right` |

### Delete rows & columns

| Action        | Default          |
| ------------- | ---------------- |
| Delete row    | `Ctrl+Backspace` |
| Delete column | `Ctrl+Delete`    |

The header row cannot be deleted, and the last remaining row/column is protected.

### Editing helpers

| Action                                      | Default       |
| ------------------------------------------- | ------------- |
| Insert a line break inside the current cell | `Shift+Enter` |
| Exit maximise mode                          | `Esc`         |

## Settings

Available under **Settings → Plugin settings → Advanced Markdown Table Editor**:

| Setting                                   | Default | What it does                                                                                                                  |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Inline edit auto-save delay (ms)**      | `500`   | How long after you stop typing in a cell before the change is written back to the block.                                      |
| **Monospace table source when editing**   | `on`    | While editing the raw markdown of a table block, render the textarea in a monospace font so aligned tables line up.           |
| **Monospace table font size offset (px)** | `-1`    | Adjust the monospace source font size relative to Logseq's base font (e.g. `-1` = 1px smaller, `0` = same, `2` = 2px larger). |
| **Pin inline table toolbar by default**   | `on`    | Keep the toolbar pinned above the focused table. Can also be toggled at runtime from the toolbar / right-click menu.          |

Reload the plugin after changing any of these.

## Notes & limitations

- **Markdown-only blocks.** The renderer only activates on blocks whose format is markdown.
- **Multiple tables in one block** must be separated by a blank line — otherwise they're parsed as a single table.
- **Header row required.** A markdown table without a header/separator row isn't recognised; deleting the header row is therefore blocked.
- **Inline renderer** uses Logseq's experimental block renderer API. On older Logseq builds without `Experiments.registerBlockRenderer`, the plugin is a clean no-op (no table view, no commands beyond the slash insert).

## Development

```shell
npm install     # install deps
npm start       # browser dev mode (no Logseq host)
npm run build   # produce build/ for loading as unpacked plugin
```

After editing source, run `npm run build` and reload the plugin in Logseq (**Settings → Plugins → ⋯ → Reload**).

## License

[MIT](./LICENSE)
