# TrainerDeck FLiNG unified managed bridge

This directory contains the Bridge 0.6.7 implementation bundled with TrainerDeck v0.6.8
for FLiNG's managed WPF and WinForms trainers. It does not send keyboard
input and it preserves CheatDeck's hotkey and original-window workflows.

The bridge has two executables:

- `TrainerDeckBridge.dll` is the single canonical bridge. It targets
  CLR2/net35 and is loaded into the trainer's existing CLR AppDomain; there is
  no second bridge binary, CLR selector, or canonical republishing step. A
  fixed metadata check rejects a target UI from another CLR generation.
  It combines the core's menu payload with a thin WPF or WinForms control
  adapter, then calls FLiNG's own `ExecuteTrainerCommand` or `ToggleCheat`
  delegate on the UI's native dispatch context.
- `TrainerDeckBridgeLauncher.exe` prepares a hidden cached copy of the trainer,
  patches only its encrypted `UI/101` managed resource, optionally starts that
  copy, and waits for it. The downloaded original trainer is never overwritten.

This is a compatibility prototype, not an anti-cheat bypass. Do not use a
trainer in an online or anti-cheat-protected game.

## Why the tooltip is part of the runtime model

Static analysis of the official *Like a Dragon: Infinite Wealth* trainer shows
that each language's menu line carries its tooltip after `**`. For example:

```text
Ctrl+数字键 3 - <input default="999">编辑恢复道具数量 --recovery_items **在打开物品菜单查看物品时生效。
Ctrl+Num 3 - Edit Recovery Items Amount **Takes effect when you view items in the items menu.
```

FLiNG's menu protocol uses `**` as the label/tooltip delimiter. WPF generations
also store those values in `m_tooltip_texts[0..2]`; older WinForms generations
can be completed from the captured menu payload. The bridge publishes:

- `tooltips` with `zh-CN`, `zh-TW`, and `en` values;
- non-empty tooltip text, from which Decky renders the exclamation indicator;
- `tooltip_style: "important"`, preserving a case-insensitive `{important}`
  marker or a red warning visual where the UI exposes one (`"normal"`
  otherwise).

Tooltip text is not scraped from the download page and is not inferred from a
hotkey description.

## Runtime behavior

`EntryPoint.Start(object mainWindow)` is intentionally idempotent. Once attached,
the bridge:

1. reads `trainerdeck-bridge.json` beside the cached trainer;
2. connects only to the manifest's `127.0.0.1` endpoint;
3. receives the core menu payload captured from `TrainerCall_SetOptionList`,
   parses its `**` tooltip metadata, and combines it with opaque option IDs
   exposed by the WPF or WinForms adapter;
4. publishes menu snapshots containing localized groups, IDs, labels and
   tooltips, control kind, input value/constraints, availability, and game
   state; only the injected core callback is authoritative for later states;
5. sends transport heartbeats from a dedicated background thread, independently
   from UI state capture;
6. receives a session-bound command containing `option_id`, `desired`, and the
   expected bridge revision;
7. rejects the request if the game is not running, the option is unavailable,
   or its current state is unknown;
8. posts one command at a time with WPF/WinForms `BeginInvoke`; if the current
   state differs from `desired`, calls the existing
   `ExecuteTrainerCommand` or `ToggleCheat` delegate via `DynamicInvoke` on
   the framework adapter's UI dispatch context, then queues the protocol reply
   to a background worker so the trainer message pump never writes the socket;
9. scopes every non-hello write to the authenticated connection generation, so
   a late command result cannot be emitted on a replacement connection;
10. leaves the trainer's own window visibility and taskbar behavior unchanged.
   State polling and panel commands never call `Hide()`, `Show()`, `Activate()`,
   or change `ShowInTaskbar`, so the original trainer remains available without
   the bridge repeatedly taking foreground focus.

A `command_accepted` includes the native result `status`. In particular, an
action reports `status: "applied"` only after its native delegate returns, so
the backend can clear that action's pending state and confirm completion.
For toggles, `status: "queued"` still means only that the native delegate was
invoked. The bridge never flips an optimistic local boolean. A later `snapshot` frame,
updated by the injected `TrainerCall_SetCheatOptionState` protocol hook, is the
state authority. A control's visual state is never used to infer that a later
click succeeded.

For newer WPF trainers, the two-string ABI is
`ExecuteTrainerCommand(option.ID, args)`. A normal trainer option must pass an
empty `args` string; the second argument is not the numeric input value. The
native core reads that value through its existing
`TrainerCall_GetInputValue(option.ID)` callback after the managed control has
been updated. Non-empty `args` are reserved for control commands such as
changing a hotkey.

Input values publish `value_controllable`, `value_type`, and
`value_apply_mode`. A `value_command` carries both the expected bridge revision
and an exact `expected_value` CAS. On the trainer UI thread the bridge validates
length, finite numeric values, min/max, and adjustment step; writes only through
`SetInputValue(string)` or a confirmed writable input property; and accepts the
command only after reading the value back. A `stage_then_toggle` write returns
`status: "staged"`, `operation: "value"`, and `invoked: false`; it does not claim
that the native core has applied the value. The backend requires both that
receipt and a snapshot echo before advancing the transaction. If the option was
active it performs core-off -> write -> core-on; if it was inactive it performs
write -> core-on. Completion requires the final authoritative core state to be
active.

An `invoke` value first writes the managed control and then calls FLiNG's native
delegate (including when the submitted value is unchanged). Its receipt is
`status: "applied"`, `operation: "value"`, and `invoked: true`; the backend also
requires the matching snapshot echo. With the two-string WPF ABI, that delegate
is invoked as `ExecuteTrainerCommand(option.ID, "")`, and the native core reads
the staged value through `TrainerCall_GetInputValue`.

Button-only `<input_set>` controls (the exact tag or any tag carrying the
`no_textbox` marker) publish `action_controllable: true` and no writable value.
An `action_command` is revision-CAS protected and calls the original trainer
delegate on the UI thread. One-argument generations receive only the option ID;
a confirmed two-string delegate receives the option ID and an empty `args`
string. The bridge never invents or exposes an editable value for this case.

## Framed JSON protocol

Every frame is:

```text
uint32_le JSON_UTF8_length
byte[JSON_UTF8_length] JSON_UTF8
```

The maximum frame size is manifest-controlled and capped at 16 MiB. The
bridge's first `hello` authenticates the stream with the per-AppID random
token; every later bridge-to-backend frame repeats that token. Backend commands
stay on the authenticated stream and carry the bound session ID plus expected
revision. The transport is deliberately plain TCP because it is restricted to
`127.0.0.1`.

Bridge to backend:

```json
{"type":"hello","protocol":1,"token":"...","app_id":2072450,"session_id":"0123456789abcdef0123456789abcdef","trainer_sha256":"...","ui_fingerprint":"...","bridge_version":"0.6.7","capabilities":["toggle_command_v1","action_command_v1","value_snapshot_v1","value_command_v1","value_command_receipt_v1","trainer_window_visible_v1","auto_return_confirmation_v1","localized_widget_fallback_v1","nonblocking_ui_commands_v1","independent_heartbeat_v1"]}
{"type":"snapshot","token":"...","session_id":"0123456789abcdef0123456789abcdef","revision":1,"game_available":true,"options":[{"id":"N1","kind":"toggle_with_input_adjustment","labels":{"zh_cn":"游戏速度","zh_tw":"遊戲速度","en":"Game Speed"},"tooltips":{},"group":{},"tooltip_style":"normal","active":false,"controllable":true,"value":"1.0","value_controllable":true,"value_type":"number","value_apply_mode":"stage_then_toggle","minimum":0.5,"maximum":10.0,"step":0.5}]}
{"type":"command_accepted","token":"...","session_id":"0123456789abcdef0123456789abcdef","request_id":"42","status":"queued"}
{"type":"command_accepted","token":"...","session_id":"0123456789abcdef0123456789abcdef","request_id":"43","status":"staged","operation":"value","value":"1.5","invoked":false}
{"type":"command_accepted","token":"...","session_id":"0123456789abcdef0123456789abcdef","request_id":"45","status":"applied","operation":"value","value":"999","invoked":true}
{"type":"command_accepted","token":"...","session_id":"0123456789abcdef0123456789abcdef","request_id":"44","status":"applied","operation":"action","invoked":true}
{"type":"heartbeat","token":"...","session_id":"0123456789abcdef0123456789abcdef"}
```

Backend to bridge:

```json
{"type":"hello_ack","protocol":1,"session_id":"0123456789abcdef0123456789abcdef"}
{"type":"command","session_id":"0123456789abcdef0123456789abcdef","request_id":"42","option_id":"N1","desired":true,"expected_bridge_revision":1}
{"type":"value_command","session_id":"0123456789abcdef0123456789abcdef","request_id":"43","option_id":"N1","value":"1.5","expected_value":"1.0","expected_bridge_revision":1}
{"type":"action_command","session_id":"0123456789abcdef0123456789abcdef","request_id":"44","option_id":"A1","expected_bridge_revision":1}
```

## Manifest

Copy `trainerdeck-bridge.example.json` to
`trainerdeck-bridge.json` beside the launcher and bridge DLL. Generate a new,
unpredictable token whenever a trainer binding is prepared. The running bridge
reloads the adjacent manifest before reconnecting, so a Decky backend restart
can rotate its port and token without restarting the game. The launcher rejects
any host other than the literal `127.0.0.1`.

Under Proton, a Linux trainer path is normally visible to the launcher through
Wine's `Z:` drive, for example:

```json
"trainer_relative": "Game Trainer.exe"
```

`cacheDirectory` may be empty. The default is:

```text
%LOCALAPPDATA%\TrainerDeck\BridgeCache\<trainer-sha256-prefix>\
```

The launcher marks the cache directory and its runtime files hidden where the
Wine-backed filesystem supports the Windows hidden attribute.

## Preparing and launching

Preparation only performs static PE/resource and managed-IL rewriting. It does
not start the trainer:

```powershell
.\TrainerDeckBridgeLauncher.exe --prepare-only
```

If preparation fails in this mode, the launcher returns a non-zero exit code
and does not start either copy.

Without `--prepare-only`, the launcher starts the prepared copy, forwards all
other arguments, waits for it, and returns its exit code:

```powershell
.\TrainerDeckBridgeLauncher.exe
```

The launcher is a `WinExe`, so it does not add a console window beside the
trainer. If patching or starting the cached copy fails in normal mode, it logs
the failure to `trainerdeck-bridge-launcher.log` and starts the untouched
original EXE (fail-open). This preserves the existing CheatDeck/original-window
workflow when a trainer generation is not compatible with the bridge.

Preparation performs these steps:

1. copy the original EXE to a staging file inside the dedicated cache;
2. read the named `UI/101` resource and preserve its language ID;
3. derive the 32-byte repeating XOR key using the standard first 32 bytes of a
   managed MZ header as known plaintext;
4. decrypt the embedded UI and validate the `MZ` signature;
5. use Mono.Cecil to route every return from
   `TrainerCall_SetFunctionPointers` through
   `TrainerDeckBridge.EntryPoint.Start(this)`;
6. in `TrainerCall_SetOptionList`, capture the two direct string payloads before
   `SetupCheatOptions(string,string)` and call
   `ReportMenuPayload(this, zhCn, en)` without consuming the original stack;
7. in `TrainerCall_SetCheatOptionState`, capture its unique
   `ReadString`/`ReadInt32` protocol values and call
   `ReportOptionState(this, id, rawState == 1)` while preserving the original
   state-update stack;
8. re-encrypt the patched UI with the same key;
9. update `UI/101` in the staging copy and publish the cached copy.

Unsupported resource formats or UI assemblies fail closed. The launcher does
not fall back to keyboard input.

The current single-bridge path has a production `--prepare-only` regression.
This is not dynamic Proton validation.

## Building

Install a current .NET SDK. The bridge targets .NET Framework 3.5, while the
launcher targets .NET Framework 4.6.2. The bridge and launcher
use the shared dependency-free JSON codec instead of `System.Web.Extensions`,
and reference-assembly packages allow all targets to be cross-compiled on Linux:

```powershell
.\build.ps1
```

or:

```bash
./build.sh
```

The launcher uses the `Mono.Cecil` PackageReference. Output is collected under
the repository's `bin/bridge/` directory with:

```text
TrainerDeckBridge.dll
TrainerDeckBridgeLauncher.exe
Mono.Cecil.dll
trainerdeck-bridge.example.json
THIRD_PARTY_NOTICES.txt
```

Building and static preparation do not execute a trainer sample. Dynamic
validation should be done only in a disposable Windows VM or a dedicated
Steam Deck/Proton test prefix.
