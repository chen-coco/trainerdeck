# TrainerDeck

[简体中文](README.md) | **English**

TrainerDeck is a Decky Loader plugin for Steam Deck Game Mode. It can identify the current game, search for and download standalone FLiNG trainers, manage Steam launch options, and mirror the controls of supported trainers in the Decky quick-access panel.

## Key Features

- Automatically detects the currently running Steam game or non-Steam shortcut.
- Automatically displays the plugin menu in Chinese or English based on the SteamOS system language; other system languages default to English.
- Searches for FLiNG trainers in Chinese or English; automatic search and setup for the current game can be enabled separately.
- Binds a trainer to the corresponding Steam library entry and adds CheatDeck-compatible launch options.
- Provides a Decky control panel for newer FLiNG trainers released in 2019 or later, including toggles, numeric inputs, and one-shot actions.
- Provides one-click launch-option recovery without deleting downloaded trainer files.

## How It Works

```text
Decky React panel
        ⇅ Decky RPC / events
Python plugin backend
        ⇅ 127.0.0.1 + random session token
TrainerDeck Bridge
        ⇅ in-process menu protocol and core acknowledgements
Supported FLiNG trainer
```

At runtime, the Bridge prepares a cached copy of the trainer instead of overwriting the downloaded EXE. Decky controls are enabled only for menu items that the Bridge explicitly confirms as compatible. Unknown controls and unsupported trainers can still use the standard download and binding features.

One physical trainer installation can be bound to only one active game entry at
a time. Unbind it from the original game before reusing it for another AppID so
two launch entries cannot overwrite the same manifest.

## Before You Use It

- Use TrainerDeck only with single-player or offline games. Do not use it in multiplayer games, anti-cheat environments, or any situation where it could affect other players.
- TrainerDeck does not bundle or redistribute game trainers. Trainers are downloaded from third-party sites after a user action, and you are responsible for evaluating the associated risks.
- FLiNG does not provide a stable API for this project. Search, download, or direct synchronization may temporarily stop working when the website or trainer implementation changes.
- Direct synchronization primarily supports managed WPF/WinForms trainers. Native UIs, unknown protocols, and some older trainers will not expose an interactive panel.
- After binding a trainer for the first time, quit and restart the game so that the trainer launches with the updated Steam launch options.
- ZIP and direct EXE downloads are supported. RAR archives are not supported.

## Installation

### Install a Release Package

1. Install Decky Loader 3.0 or later.
2. Download `TrainerDeck-<version>.zip` from [Releases](https://github.com/chen-coco/trainerdeck/releases). If no prebuilt package is available, follow the “Build from Source” section below.
3. Transfer the ZIP file to your Steam Deck, for example to `~/Downloads/`.
4. Open the “Developer” page in Decky settings and select “Install Plugin from ZIP File.”
5. Select the ZIP file, then reload the plugins or restart Decky Loader.

Do not use the automatically generated GitHub “Source code” archives as plugin installation packages.

## Basic Usage

1. Start the target game, then open `…` → Decky → TrainerDeck.
2. Confirm the detected game name and select “Search.” You can also enter part of a Chinese title or an English game name manually.
3. Select a matching result to download and bind it. If no current game is detected, TrainerDeck downloads the trainer without changing Steam launch options.
4. Quit and restart the game after the first binding.
5. Open TrainerDeck again. Compatible trainers will display a “Trainer Panel.”
6. When finished, close the quick-access menu normally. The original trainer window remains available through Steam's window switcher.

The settings page lets you change the download directory and optionally enable:

- automatic search and setup for the current game;
- game-input recovery after closing the entire quick-access menu.

These automatic features are disabled by default. If TrainerDeck detects existing CheatDeck or other managed launch settings, automatic binding is skipped to avoid silently overwriting the current configuration.

## Network and Privacy

- Search and download operations access FLiNG's public pages or indexes.
- Manual Chinese searches may send the query text to the MyMemory translation service and use Wikimedia and Steam information to verify the English title.
- “Automatically search for and add the current game” is disabled by default. While disabled, detecting the current game does not trigger an automatic online search or download.
- Bridge communication listens only on `127.0.0.1` and uses a randomly generated token for each session.

## Recovery and Troubleshooting

If a game no longer starts after binding, you do not need to launch the target game first. Open the TrainerDeck home page and select “Restore Launch Options.” TrainerDeck restores the saved launch options for the Steam game or non-Steam shortcut without deleting trainer files.

Other common checks:

- Plugin not shown: make sure the installation did not create `TrainerDeck/TrainerDeck/plugin.json`.
- Backend failed to load: run `sudo journalctl -u plugin_loader.service -b --no-pager | grep -i TrainerDeck`.
- The panel reports an outdated Bridge: upgrade or repair the direct-synchronization component, then restart the game.
- A menu item is unavailable: the Bridge has not confirmed its control type, invocation method, or current state. TrainerDeck does not fall back to simulated keystrokes.

## Build from Source

### Requirements

- Node.js 16.14 or later
- pnpm 9
- Python 3.10 or later
- .NET SDK

### Windows PowerShell

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
./bridge/build.ps1 -Configuration Release
pnpm test
pnpm run package
```

### Linux or macOS

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
./bridge/build.sh Release
pnpm test
pnpm run package
```

`pnpm run package` only collects and validates existing build artifacts. It does not rebuild the frontend or Bridge automatically. The installation package is generated at:

```text
release/TrainerDeck-<version>.zip
```

The current version produces `release/TrainerDeck-0.7.0.zip`.

`TrainerDeckBridgeLauncher.exe` embeds both CLR2 and CLR4 Bridge payloads. At
runtime it selects the payload whose metadata generation exactly matches the
trainer's managed UI and writes only the canonical `TrainerDeckBridge.dll` into
the dedicated cache. No standalone `TrainerDeckBridge*.dll` payload is shipped
in the plugin archive.

The installation package has the following main structure:

```text
TrainerDeck/
├── dist/index.js
├── main.py
├── py_modules/
│   ├── trainerdeck_core.py
│   └── trainerdeck_runtime.py
├── bin/bridge/
│   ├── TrainerDeckBridgeLauncher.exe
│   └── Mono.Cecil.dll
├── package.json
├── plugin.json
├── README.md
├── README_EN.md
└── LICENSE
```

## Project Structure

| Path | Purpose |
| --- | --- |
| `src/` | Decky React/TypeScript frontend |
| `main.py` | Decky Python entry point |
| `trainerdeck_core.py` | Search, download, installation, and binding logic |
| `trainerdeck_runtime.py` | Trainer runtime and Bridge session management |
| `bridge/` | .NET Bridge, Launcher, and build scripts |
| `scripts/package.py` | Installation-package generation and content validation |
| `tests/` | Python, Node.js, and Bridge regression tests |
| `docs/` | Architecture, security boundaries, and synchronization protocol documentation |

## Contributing

Issues and pull requests are welcome. Do not commit downloaded trainers, game files, analysis samples, access tokens, or logs containing personal paths. Remove usernames, directories, and other sensitive information before attaching logs to an issue.

## License

The project is licensed under [GPL-3.0-or-later](LICENSE). Attribution and license information for `Mono.Cecil` and other third-party components is available in [bridge/THIRD_PARTY_NOTICES.txt](bridge/THIRD_PARTY_NOTICES.txt).
