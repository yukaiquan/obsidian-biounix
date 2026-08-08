# BioUnix

Run bioinformatics commands, chat with an Agent, and browse skills and memories from BioUnix — directly inside Obsidian.

This plugin integrates [BioUnix](https://github.com/yukaiquan/biounix-electron) with Obsidian. It connects to the local BioUnix API Server (default `http://127.0.0.1:17564`) and exposes the following features:

## Features

- **Code blocks**: Run BioUnix commands inline in any Markdown note using a `biounix` fenced code block.
- **Sidebar chat**: A dedicated Agent chat view with streaming responses over WebSocket.
- **File menu**: Right-click any file in the vault to send it to the BioUnix Agent for analysis.
- **Vault report**: Scan your vault for bioinformatics files and generate a report.
- **Command palette**: Quick actions to open the chat or send the current file to the Agent.

## Prerequisites

1. Install and run the [BioUnix](https://github.com/yukaiquan/biounix-electron) desktop app.
2. The BioUnix API Server must be running locally (it starts automatically with the app).
3. An API token is auto-read from `~/.biounix/api-token`; you can also set it manually in settings.

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community plugins**.
2. Search for "BioUnix" and install it.
3. Enable the plugin.

### Manual installation

1. Download `main.js`, `manifest.json`, `styles.css`, and `icon.png` from the latest [release](https://github.com/yukaiquan/obsidian-biounix/releases).
2. Create a folder named `biounix` inside your vault's `.obsidian/plugins/` directory.
3. Copy the four files into that folder.
4. Enable the plugin in **Settings → Community plugins**.

## Usage

### Code blocks

````markdown
```biounix
run: samtools view -h sample.bam | head
```
````

### Sidebar chat

Click the flask icon in the left ribbon, or run the command **Open BioUnix Agent chat**.

### Settings

- **API port**: The port the BioUnix API Server listens on (default `17564`).
- **API token**: Authentication token; leave empty to auto-read from `~/.biounix/api-token`.
- **Auto-connect**: Connect to the server on plugin load.
- **Default mode**: `chat` or `agent` mode for new sessions.

## License

[MIT](./LICENSE)
