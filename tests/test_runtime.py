import asyncio
import json
import os
import shutil
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from trainerdeck_runtime import (
    BRIDGE_ASSET_FILENAMES,
    MAX_FRAME_BYTES,
    OBSOLETE_MULTI_BRIDGE_ASSET_FILENAMES,
    TrainerRuntimeError,
    TrainerRuntimeManager,
    _read_frame,
    _sanitize_option,
    _write_frame,
)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.assets = self.root / "assets"
        self.assets.mkdir()
        for name in BRIDGE_ASSET_FILENAMES:
            if name.endswith(".config"):
                continue
            (self.assets / name).write_bytes(b"test")
        self.manager = TrainerRuntimeManager(
            runtime_dir=self.root / "runtime",
            bridge_assets_dir=self.assets,
        )
        self.events = []

        async def receive(snapshot):
            self.events.append(snapshot)

        await self.manager.start(receive)
        self.installation_folder = self.root / "trainer"
        self.installation_folder.mkdir()
        self.executable = self.installation_folder / "Game Trainer.exe"
        self.executable.write_bytes(b"MZ" + b"\0" * 64)
        self.installation = {
            "id": "installed",
            "folder": str(self.installation_folder),
            "executable": str(self.executable),
            "sha256": "a" * 64,
        }
        self.prepared = self.manager.prepare_bridge(1234, self.installation)
        manifest_path = Path(self.prepared["manifest"])
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    async def asyncTearDown(self):
        await self.manager.stop()
        self.temporary.cleanup()

    async def connect_bridge(
        self,
        token=None,
        session_id="session-test-1234",
        bridge_version="0.4.0",
        capabilities=None,
    ):
        reader, writer = await asyncio.open_connection(
            "127.0.0.1",
            self.manager.port,
        )
        if capabilities is None:
            capabilities = [
                "toggle_command_v1",
                "value_snapshot_v1",
                "value_command_v1",
                "action_command_v1",
                "trainer_window_visible_v1",
            ]
        await _write_frame(
            writer,
            {
                "type": "hello",
                "protocol": 1,
                "token": self.manifest["token"] if token is None else token,
                "app_id": 1234,
                "session_id": session_id,
                "trainer_sha256": self.prepared["trainer_sha256"],
                "bridge_version": bridge_version,
                "capabilities": capabilities,
                "ui_fingerprint": "fling-wpf-test",
            },
        )
        return reader, writer

    async def test_bridge_identity_and_capabilities_are_exposed_safely(self):
        reader, writer = await self.connect_bridge(
            session_id="session-capability-1234",
            bridge_version=" 0.4.0\x00ignored ",
            capabilities=[
                "value_command_v1",
                "value_command_v1",
                None,
                "trainer_window_visible_v1",
            ],
        )
        await _read_frame(reader)
        snapshot = self.manager.get_snapshot(1234)
        self.assertEqual(snapshot["bridge_version"], "0.4.0ignored")
        self.assertEqual(
            snapshot["capabilities"],
            ["value_command_v1", "trainer_window_visible_v1"],
        )
        writer.close()
        await writer.wait_closed()

    async def publish_menu(
        self,
        writer,
        session_id,
        revision,
        active,
        *,
        kind="toggle",
        value=None,
        value_controllable=False,
        value_type="none",
        value_apply_mode="none",
        action_controllable=False,
        minimum=None,
        maximum=None,
        step=None,
    ):
        option = {
            "id": "N1",
            "kind": kind,
            "labels": {
                "zh_cn": "无限生命",
                "en": "Infinite Health",
            },
            "tooltips": {
                "zh_cn": "切换到对应菜单后生效。\n请勿用于在线模式。",
                "en": "Takes effect in the matching menu.",
            },
            "group": {
                "zh_cn": "玩家",
                "en": "Player",
            },
            "tooltip_style": "important",
            "active": active,
            "controllable": True,
            "value_controllable": value_controllable,
            "value_type": value_type,
            "value_apply_mode": value_apply_mode,
            "action_controllable": action_controllable,
        }
        if value is not None:
            option["value"] = value
        if minimum is not None:
            option["minimum"] = minimum
        if maximum is not None:
            option["maximum"] = maximum
        if step is not None:
            option["step"] = step
        await _write_frame(
            writer,
            {
                "type": "snapshot",
                "session_id": session_id,
                "revision": revision,
                "game_available": True,
                "options": [option],
            },
        )

    async def wait_until(self, predicate, timeout=1.0):
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if predicate():
                return
            await asyncio.sleep(0.01)
        self.fail("timed out waiting for runtime state")

    async def test_prepare_bridge_writes_scoped_manifest_and_assets(self):
        self.assertTrue(self.prepared["supported"])
        self.assertEqual(
            Path(self.prepared["launch_executable"]).parent,
            self.installation_folder,
        )
        self.assertEqual(self.manifest["host"], "127.0.0.1")
        self.assertEqual(self.manifest["app_id"], 1234)
        self.assertEqual(self.manifest["trainer_relative"], "Game Trainer.exe")
        self.assertEqual(
            self.manifest["trainer_sha256"],
            self.prepared["trainer_sha256"],
        )
        self.assertNotEqual(self.manifest["trainer_sha256"], "a" * 64)
        self.assertEqual(len(self.manifest["token"]), 64)
        self.assertTrue(
            (
                self.installation_folder
                / "TrainerDeckBridgeLauncher.exe"
            ).is_file()
        )
        self.assertTrue(
            (self.installation_folder / "Mono.Cecil.dll").is_file()
        )
        self.assertFalse(
            (self.installation_folder / "TrainerDeckBridge.dll").exists()
        )
        for obsolete in OBSOLETE_MULTI_BRIDGE_ASSET_FILENAMES:
            self.assertNotIn(obsolete, BRIDGE_ASSET_FILENAMES)

    async def test_prepare_bridge_overwrites_assets_from_an_older_binding(self):
        expected = {}
        for index, name in enumerate(BRIDGE_ASSET_FILENAMES):
            source = self.assets / name
            if not source.is_file():
                continue
            payload = f"v0.5.0-asset-{index}".encode("ascii")
            source.write_bytes(payload)
            (self.installation_folder / name).write_bytes(b"v0.4.9-stale")
            expected[name] = payload

        prepared = self.manager.prepare_bridge(1234, self.installation)

        self.assertTrue(prepared["supported"])
        self.assertEqual(
            Path(prepared["launch_executable"]),
            self.installation_folder / "TrainerDeckBridgeLauncher.exe",
        )
        for name, payload in expected.items():
            self.assertEqual(
                (self.installation_folder / name).read_bytes(),
                payload,
            )

    async def test_prepare_bridge_removes_only_obsolete_multi_bridge_assets(self):
        for name in OBSOLETE_MULTI_BRIDGE_ASSET_FILENAMES:
            (self.installation_folder / name).write_bytes(b"obsolete")
        unrelated = self.installation_folder / "user-file.dll"
        unrelated.write_bytes(b"preserve")

        self.manager.prepare_bridge(1234, self.installation)

        for name in OBSOLETE_MULTI_BRIDGE_ASSET_FILENAMES:
            self.assertFalse((self.installation_folder / name).exists())
        self.assertEqual(unrelated.read_bytes(), b"preserve")

    async def test_prepare_bridge_serializes_concurrent_file_transactions(self):
        real_copy2 = shutil.copy2
        real_replace = os.replace
        counter_lock = threading.Lock()
        active_copies = 0
        maximum_active_copies = 0
        manifest_staging_names = []
        live_paths_visible_before_publish = []

        def slow_copy(source, destination, *args, **kwargs):
            nonlocal active_copies, maximum_active_copies
            with counter_lock:
                active_copies += 1
                maximum_active_copies = max(
                    maximum_active_copies,
                    active_copies,
                )
            try:
                time.sleep(0.02)
                return real_copy2(source, destination, *args, **kwargs)
            finally:
                with counter_lock:
                    active_copies -= 1

        def record_replace(source, destination):
            source_path = Path(source)
            destination_path = Path(destination)
            if (
                destination_path.name == "trainerdeck-bridge.json"
                and source_path.name.endswith(".stage")
            ):
                manifest_staging_names.append(source_path.name)
            if source_path.name.endswith(".stage"):
                live_paths_visible_before_publish.append(
                    destination_path.exists()
                )
            return real_replace(source, destination)

        with (
            patch("trainerdeck_runtime.shutil.copy2", side_effect=slow_copy),
            patch("trainerdeck_runtime.os.replace", side_effect=record_replace),
        ):
            results = await asyncio.gather(
                asyncio.to_thread(
                    self.manager.prepare_bridge,
                    1234,
                    self.installation,
                ),
                asyncio.to_thread(
                    self.manager.prepare_bridge,
                    1234,
                    self.installation,
                ),
            )

        self.assertTrue(all(result["supported"] for result in results))
        self.assertEqual(maximum_active_copies, 1)
        self.assertEqual(len(manifest_staging_names), 2)
        self.assertEqual(len(set(manifest_staging_names)), 2)
        self.assertTrue(all(live_paths_visible_before_publish))
        for name in manifest_staging_names:
            transaction_id = name.removesuffix(".stage").rsplit(".", 1)[-1]
            self.assertEqual(len(transaction_id), 32)
            self.assertTrue(
                all(
                    character in "0123456789abcdef"
                    for character in transaction_id
                )
            )
        leftovers = [
            path.name
            for path in self.installation_folder.iterdir()
            if path.name.startswith(".")
            and path.name.endswith((".stage", ".backup", ".obsolete"))
        ]
        self.assertEqual(leftovers, [])

    async def test_stop_cancels_inflight_prepare_without_post_stop_state(self):
        for cycle in range(3):
            delayed_reader, delayed_writer = await asyncio.open_connection(
                "127.0.0.1",
                self.manager.port,
            )
            await self.wait_until(
                lambda: bool(self.manager._inbound_writers)
            )
            entered_deploy = threading.Event()
            release_deploy = threading.Event()
            real_deploy = self.manager._deploy_bridge_files

            def delayed_deploy(*args, **kwargs):
                entered_deploy.set()
                if not release_deploy.wait(2.0):
                    raise AssertionError("test did not release bridge deployment")
                return real_deploy(*args, **kwargs)

            with patch.object(
                self.manager,
                "_deploy_bridge_files",
                side_effect=delayed_deploy,
            ):
                prepare_task = asyncio.create_task(
                    asyncio.to_thread(
                        self.manager.prepare_bridge,
                        1234,
                        self.installation,
                    )
                )
                self.assertTrue(
                    await asyncio.to_thread(entered_deploy.wait, 1.0)
                )
                stop_task = asyncio.create_task(self.manager.stop())
                await self.wait_until(lambda: not self.manager.running)
                self.assertEqual(
                    await asyncio.wait_for(
                        delayed_reader.read(1),
                        timeout=1.0,
                    ),
                    b"",
                )
                await self.wait_until(
                    lambda: not self.manager._inbound_writers
                    and not self.manager._handler_tasks
                )
                self.assertFalse(stop_task.done())
                release_deploy.set()
                with self.assertRaisesRegex(
                    TrainerRuntimeError,
                    "已停止",
                ):
                    await asyncio.wait_for(prepare_task, timeout=2.0)
                await asyncio.wait_for(stop_task, timeout=2.0)

            self.assertFalse(self.manager.running)
            self.assertEqual(self.manager._tokens, {})
            self.assertEqual(self.manager._prepared, {})
            self.assertEqual(self.manager._installation_owners, {})
            self.assertEqual(self.manager._owned_installations, {})
            self.assertEqual(self.manager._inbound_writers, set())
            self.assertEqual(self.manager._handler_tasks, set())
            self.assertTrue(
                (self.installation_folder / "trainerdeck-bridge.json").is_file()
            )
            delayed_writer.close()
            await delayed_writer.wait_closed()
            with self.assertRaisesRegex(
                TrainerRuntimeError,
                "停止",
            ):
                self.manager.prepare_bridge(1234, self.installation)

            if cycle < 2:
                await self.manager.start()
                self.manager.prepare_bridge(1234, self.installation)

    async def test_accept_registers_writer_before_handler_task_runs(self):
        reader = asyncio.StreamReader()
        writer = MagicMock()
        writer.get_extra_info.return_value = ("127.0.0.1", 54321)
        writer.wait_closed = AsyncMock()

        self.manager._accept_client(reader, writer)

        self.assertIn(writer, self.manager._inbound_writers)
        self.assertEqual(len(self.manager._handler_tasks), 1)
        handler_task = next(iter(self.manager._handler_tasks))
        self.assertFalse(handler_task.done())

        await asyncio.wait_for(self.manager.stop(), timeout=1.0)

        writer.close.assert_called()
        writer.wait_closed.assert_awaited()
        self.assertTrue(handler_task.done())
        self.assertEqual(self.manager._inbound_writers, set())
        self.assertEqual(self.manager._handler_tasks, set())
        self.assertEqual(self.manager._writers, {})
        self.assertEqual(self.manager._sessions, {})

    async def test_stop_cancels_handler_blocked_in_change_callback(self):
        callback_entered = asyncio.Event()
        callback_blocker = asyncio.Event()

        async def blocking_change(_snapshot):
            callback_entered.set()
            await callback_blocker.wait()

        self.manager._on_change = blocking_change
        reader, writer = await self.connect_bridge(
            session_id="session-blocked-change-1234"
        )
        self.assertEqual((await _read_frame(reader))["type"], "hello_ack")
        await asyncio.wait_for(callback_entered.wait(), timeout=1.0)
        self.assertIn(1234, self.manager._sessions)

        await asyncio.wait_for(self.manager.stop(), timeout=1.0)

        self.assertFalse(callback_blocker.is_set())
        self.assertEqual(self.manager._inbound_writers, set())
        self.assertEqual(self.manager._handler_tasks, set())
        self.assertEqual(self.manager._writers, {})
        self.assertEqual(self.manager._sessions, {})
        self.assertEqual(
            await asyncio.wait_for(reader.read(1), timeout=1.0),
            b"",
        )
        writer.close()
        await writer.wait_closed()

    async def test_asset_replace_failure_rolls_back_and_keeps_legacy_bridge(self):
        old_assets = {}
        for index, name in enumerate(BRIDGE_ASSET_FILENAMES):
            destination = self.installation_folder / name
            old_payload = f"old-asset-{index}".encode("ascii")
            new_payload = f"new-asset-{index}".encode("ascii")
            destination.write_bytes(old_payload)
            (self.assets / name).write_bytes(new_payload)
            old_assets[name] = old_payload
        manifest_path = Path(self.prepared["manifest"])
        old_manifest = manifest_path.read_bytes()
        legacy_bridge = self.installation_folder / "TrainerDeckBridge.dll"
        legacy_bridge.write_bytes(b"legacy-bridge")
        old_token = self.manager._tokens[1234]

        real_replace = os.replace
        failure_injected = False

        def fail_cecil_publish(source, destination):
            nonlocal failure_injected
            source_path = Path(source)
            destination_path = Path(destination)
            if (
                not failure_injected
                and destination_path.name == "Mono.Cecil.dll"
                and source_path.name.endswith(".stage")
            ):
                failure_injected = True
                raise PermissionError("simulated locked Cecil destination")
            return real_replace(source, destination)

        with patch(
            "trainerdeck_runtime.os.replace",
            side_effect=fail_cecil_publish,
        ):
            with self.assertRaisesRegex(
                TrainerRuntimeError,
                "\u65e0\u6cd5\u5b89\u5168\u66f4\u65b0",
            ):
                self.manager.prepare_bridge(1234, self.installation)

        self.assertTrue(failure_injected)
        for name, payload in old_assets.items():
            self.assertEqual(
                (self.installation_folder / name).read_bytes(),
                payload,
            )
        self.assertEqual(manifest_path.read_bytes(), old_manifest)
        self.assertEqual(self.manager._tokens[1234], old_token)
        self.assertEqual(legacy_bridge.read_bytes(), b"legacy-bridge")
        leftovers = [
            path.name
            for path in self.installation_folder.iterdir()
            if path.name.startswith(".")
            and path.name.endswith((".stage", ".backup", ".obsolete"))
        ]
        self.assertEqual(leftovers, [])

    async def test_installation_owner_blocks_manifest_overwrite_until_revoke(self):
        manifest_path = Path(self.prepared["manifest"])
        original_manifest = manifest_path.read_bytes()
        same_folder_different_id = {
            **self.installation,
            "id": "different-logical-installation",
        }

        with self.assertRaisesRegex(
            TrainerRuntimeError,
            "AppID 1234",
        ):
            self.manager.prepare_bridge(5678, same_folder_different_id)

        self.assertEqual(manifest_path.read_bytes(), original_manifest)
        self.assertNotIn(5678, self.manager._tokens)

        foreign_manifest = {
            **self.manifest,
            "app_id": 9999,
            "token": "f" * 64,
        }
        manifest_path.write_text(
            json.dumps(foreign_manifest, ensure_ascii=False),
            encoding="utf-8",
        )
        await self.manager.revoke_app(1234)
        self.assertEqual(
            json.loads(manifest_path.read_text(encoding="utf-8")),
            foreign_manifest,
        )

        replacement = self.manager.prepare_bridge(
            5678,
            same_folder_different_id,
        )
        replacement_manifest = json.loads(
            Path(replacement["manifest"]).read_text(encoding="utf-8")
        )
        self.assertEqual(replacement_manifest["app_id"], 5678)
        self.assertNotEqual(
            replacement_manifest["token"],
            self.manifest["token"],
        )

    async def test_prepare_failure_is_visible_in_runtime_snapshot(self):
        failure = self.manager.record_prepare_failure(
            1234,
            self.installation,
            PermissionError("destination is read-only"),
        )

        self.assertFalse(failure["supported"])
        self.assertEqual(failure["status"], "error")
        snapshot = self.manager.get_snapshot(1234)
        self.assertEqual(snapshot["status"], "error")
        self.assertIn("destination is read-only", snapshot["message"])

    async def test_non_steam_uint32_app_id_round_trips_without_truncation(self):
        shortcut_app_id = 3908080889
        shortcut_folder = self.root / "shortcut-trainer"
        shortcut_folder.mkdir()
        shortcut_executable = shortcut_folder / "Shortcut Trainer.exe"
        shortcut_executable.write_bytes(b"MZ" + b"\0" * 64)
        shortcut_installation = {
            "id": "installed-shortcut",
            "folder": str(shortcut_folder),
            "executable": str(shortcut_executable),
            "sha256": "b" * 64,
        }
        prepared = self.manager.prepare_bridge(
            shortcut_app_id,
            shortcut_installation,
        )
        manifest = json.loads(
            Path(prepared["manifest"]).read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["app_id"], shortcut_app_id)

        reader, writer = await asyncio.open_connection(
            "127.0.0.1",
            self.manager.port,
        )
        await _write_frame(
            writer,
            {
                "type": "hello",
                "protocol": 1,
                "token": manifest["token"],
                "app_id": shortcut_app_id,
                "session_id": "session-shortcut-3908080889",
                "trainer_sha256": prepared["trainer_sha256"],
                "bridge_version": "0.4.0",
                "capabilities": [],
            },
        )
        hello_ack = await _read_frame(reader)
        self.assertEqual(hello_ack["type"], "hello_ack")
        self.assertTrue(self.manager.get_snapshot(shortcut_app_id)["connected"])
        writer.close()
        await writer.wait_closed()

        repository = Path(__file__).resolve().parents[1]
        manifest_source = (
            repository / "bridge" / "Shared" / "BridgeManifest.cs"
        ).read_text(encoding="utf-8")
        runtime_source = (
            repository / "bridge" / "TrainerDeckBridge" / "BridgeRuntime.cs"
        ).read_text(encoding="utf-8")
        protocol_source = (
            repository / "bridge" / "TrainerDeckBridge" / "ProtocolModels.cs"
        ).read_text(encoding="utf-8")
        self.assertIn("public long app_id", manifest_source)
        self.assertIn("app_id > uint.MaxValue", manifest_source)
        self.assertIn("private readonly long appId", runtime_source)
        self.assertIn("long appId", protocol_source)

    def test_value_contract_mismatch_fails_closed(self):
        base = {
            "id": "N1",
            "kind": "toggle_with_input",
            "value": "2",
            "value_controllable": True,
            "value_type": "number",
        }
        missing_mode = _sanitize_option(base)
        self.assertIsNotNone(missing_mode)
        self.assertFalse(missing_mode["value_controllable"])

        wrong_mode = _sanitize_option({**base, "value_apply_mode": "invoke"})
        self.assertIsNotNone(wrong_mode)
        self.assertFalse(wrong_mode["value_controllable"])

        valid = _sanitize_option(
            {**base, "value_apply_mode": "stage_then_toggle"}
        )
        self.assertIsNotNone(valid)
        self.assertTrue(valid["value_controllable"])

        pure_action = _sanitize_option(
            {
                "id": "A1",
                "kind": "action",
                "action_controllable": True,
                "value_type": "none",
                "value_apply_mode": "none",
            }
        )
        self.assertIsNotNone(pure_action)
        self.assertTrue(pure_action["action_controllable"])
        self.assertFalse(pure_action["value_controllable"])

        half_old_action = _sanitize_option(
            {
                "id": "A2",
                "kind": "action",
                "action_controllable": True,
                "value_type": "integer",
                "value_apply_mode": "none",
            }
        )
        self.assertIsNotNone(half_old_action)
        self.assertFalse(half_old_action["action_controllable"])

        contradictory_action = _sanitize_option(
            {
                "id": "A3",
                "kind": "action",
                "action_controllable": True,
                "value_controllable": True,
                "value": "999",
                "value_type": "integer",
                "value_apply_mode": "invoke",
            }
        )
        self.assertIsNotNone(contradictory_action)
        self.assertFalse(contradictory_action["action_controllable"])
        self.assertTrue(contradictory_action["value_controllable"])

        wrong_kind_action = _sanitize_option(
            {
                "id": "A4",
                "kind": "toggle",
                "action_controllable": True,
                "value_type": "none",
                "value_apply_mode": "none",
            }
        )
        self.assertIsNotNone(wrong_kind_action)
        self.assertFalse(wrong_kind_action["action_controllable"])

    async def test_menu_tooltip_and_core_ack_are_bidirectional(self):
        session_id = "session-test-1234"
        reader, writer = await self.connect_bridge(session_id=session_id)
        hello_ack = await _read_frame(reader)
        self.assertEqual(hello_ack["type"], "hello_ack")
        await self.publish_menu(writer, session_id, 1, False)
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )

        snapshot = self.manager.get_snapshot(1234)
        option = snapshot["options"][0]
        self.assertEqual(
            option["tooltips"]["zh_cn"],
            "切换到对应菜单后生效。\n请勿用于在线模式。",
        )
        self.assertEqual(option["tooltip_style"], "important")
        self.assertFalse(option["active"])

        request_task = asyncio.create_task(
            self.manager.set_option(
                1234,
                session_id,
                "N1",
                True,
                snapshot["revision"],
            )
        )
        command = await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        self.assertTrue(pending["options"][0]["pending"])
        self.assertFalse(pending["options"][0]["active"])
        self.assertFalse(request_task.done())
        self.assertEqual(command["type"], "command")
        self.assertEqual(command["option_id"], "N1")
        self.assertTrue(command["desired"])

        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
            },
        )
        await self.publish_menu(writer, session_id, 2, True)
        confirmed = await request_task
        self.assertTrue(confirmed["options"][0]["active"])
        self.assertFalse(confirmed["options"][0]["pending"])
        writer.close()
        await writer.wait_closed()

    async def test_stage_value_from_inactive_waits_for_receipt_echo_and_toggle_on(self):
        session_id = "session-value-1234"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="toggle_with_input_adjustment",
            value="2.0",
            value_controllable=True,
            value_type="number",
            value_apply_mode="stage_then_toggle",
            minimum=0.5,
            maximum=10.0,
            step=0.5,
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)

        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "3.5",
                "2.0",
                snapshot["revision"],
            )
        )
        command = await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        option = pending["options"][0]
        self.assertTrue(option["value_pending"])
        self.assertEqual(option["desired_value"], "3.5")
        self.assertFalse(option["pending"])
        self.assertFalse(request_task.done())
        self.assertEqual(command["type"], "value_command")
        self.assertEqual(command["option_id"], "N1")
        self.assertEqual(command["value"], "3.5")
        self.assertEqual(command["expected_bridge_revision"], 1)

        # A matching snapshot alone is not proof that the bridge accepted the
        # write. Keep the compound transaction pending until both signals exist.
        await self.publish_menu(
            writer,
            session_id,
            2,
            False,
            kind="toggle_with_input_adjustment",
            value="3.5",
            value_controllable=True,
            value_type="number",
            value_apply_mode="stage_then_toggle",
            minimum=0.5,
            maximum=10.0,
            step=0.5,
        )
        await asyncio.sleep(0.02)
        self.assertFalse(request_task.done())
        self.assertTrue(
            self.manager.get_snapshot(1234)["options"][0]["value_pending"]
        )

        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
                "status": "staged",
                "operation": "value",
                "invoked": False,
            },
        )
        toggle_on = await asyncio.wait_for(_read_frame(reader), timeout=0.5)
        self.assertEqual(toggle_on["type"], "command")
        self.assertEqual(toggle_on["option_id"], "N1")
        self.assertTrue(toggle_on["desired"])
        self.assertEqual(toggle_on["expected_bridge_revision"], 2)
        self.assertFalse(request_task.done())

        await self.publish_menu(
            writer,
            session_id,
            3,
            True,
            kind="toggle_with_input_adjustment",
            value="3.5",
            value_controllable=True,
            value_type="number",
            value_apply_mode="stage_then_toggle",
            minimum=0.5,
            maximum=10.0,
            step=0.5,
        )
        confirmed = (await request_task)["options"][0]
        self.assertEqual(confirmed["value"], "3.5")
        self.assertTrue(confirmed["active"])
        self.assertIsNone(confirmed["desired_value"])
        self.assertFalse(confirmed["value_pending"])
        self.assertEqual(confirmed["value_error"], "")
        writer.close()
        await writer.wait_closed()

    async def test_stage_value_from_active_turns_off_writes_and_turns_back_on(self):
        session_id = "session-value-active"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            True,
            kind="toggle_with_input",
            value="2",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "7",
                "2",
                snapshot["revision"],
            )
        )

        toggle_off = await _read_frame(reader)
        self.assertEqual(toggle_off["type"], "command")
        self.assertFalse(toggle_off["desired"])
        self.assertTrue(
            self.manager.get_snapshot(1234)["options"][0]["value_pending"]
        )
        await self.publish_menu(
            writer,
            session_id,
            2,
            False,
            kind="toggle_with_input",
            value="2",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )

        value_command = await asyncio.wait_for(_read_frame(reader), timeout=0.5)
        self.assertEqual(value_command["type"], "value_command")
        self.assertEqual(value_command["value"], "7")
        self.assertEqual(value_command["expected_bridge_revision"], 2)
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": value_command["request_id"],
                "status": "staged",
                "operation": "value",
                "invoked": False,
            },
        )
        await self.publish_menu(
            writer,
            session_id,
            3,
            False,
            kind="toggle_with_input",
            value="7",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )

        toggle_on = await asyncio.wait_for(_read_frame(reader), timeout=0.5)
        self.assertEqual(toggle_on["type"], "command")
        self.assertTrue(toggle_on["desired"])
        self.assertEqual(toggle_on["expected_bridge_revision"], 3)
        await self.publish_menu(
            writer,
            session_id,
            4,
            True,
            kind="toggle_with_input",
            value="7",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        confirmed = (await request_task)["options"][0]
        self.assertTrue(confirmed["active"])
        self.assertEqual(confirmed["value"], "7")
        self.assertFalse(confirmed["value_pending"])
        writer.close()
        await writer.wait_closed()

    async def test_stage_matching_value_enables_inactive_but_active_is_noop(self):
        session_id = "session-value-matching"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="toggle_with_input",
            value="5",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "5",
                "5",
                snapshot["revision"],
            )
        )
        toggle_on = await _read_frame(reader)
        self.assertEqual(toggle_on["type"], "command")
        self.assertTrue(toggle_on["desired"])
        self.assertNotEqual(toggle_on["type"], "value_command")
        await self.publish_menu(
            writer,
            session_id,
            2,
            True,
            kind="toggle_with_input",
            value="5",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        enabled = (await request_task)["options"][0]
        self.assertTrue(enabled["active"])
        self.assertFalse(enabled["value_pending"])

        active_snapshot = self.manager.get_snapshot(1234)
        active_result = await asyncio.wait_for(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "5.0",
                "5",
                active_snapshot["revision"],
            ),
            timeout=0.1,
        )
        self.assertTrue(active_result["options"][0]["active"])
        writer.close()
        await writer.wait_closed()

    async def test_stage_value_accepts_legacy_receipt_but_rejects_wrong_shape(self):
        session_id = "session-value-legacy"
        reader, writer = await self.connect_bridge(
            session_id=session_id,
            bridge_version="0.4.1",
        )
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="toggle_with_input",
            value="1",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "2",
                "1",
                snapshot["revision"],
            )
        )
        value_command = await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            2,
            False,
            kind="toggle_with_input",
            value="2",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": value_command["request_id"],
                "status": "staged",
                "operation": "toggle",
                "invoked": False,
            },
        )
        await asyncio.sleep(0.02)
        self.assertFalse(request_task.done())
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": value_command["request_id"],
                "operation": "value",
                "invoked": False,
            },
        )
        toggle_on = await asyncio.wait_for(_read_frame(reader), timeout=0.5)
        self.assertTrue(toggle_on["desired"])
        await self.publish_menu(
            writer,
            session_id,
            3,
            True,
            kind="toggle_with_input",
            value="2",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        confirmed = await request_task
        self.assertTrue(confirmed["options"][0]["active"])
        writer.close()
        await writer.wait_closed()

    async def test_stage_value_error_aborts_compound_transaction(self):
        session_id = "session-value-error"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            True,
            kind="toggle_with_input",
            value="1",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "2",
                "1",
                snapshot["revision"],
            )
        )
        await _read_frame(reader)  # toggle off
        await self.publish_menu(
            writer,
            session_id,
            2,
            False,
            kind="toggle_with_input",
            value="1",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        value_command = await _read_frame(reader)
        self.assertEqual(value_command["type"], "value_command")
        await _write_frame(
            writer,
            {
                "type": "command_error",
                "session_id": session_id,
                "request_id": value_command["request_id"],
                "message": "数值写入被修改器拒绝",
            },
        )
        with self.assertRaisesRegex(TrainerRuntimeError, "数值写入"):
            await request_task
        failed = self.manager.get_snapshot(1234)["options"][0]
        self.assertFalse(failed["value_pending"])
        self.assertIsNone(failed["desired_value"])
        self.assertIn("数值写入", failed["value_error"])
        writer.close()
        await writer.wait_closed()

    async def test_value_echo_without_valid_receipt_times_out(self):
        session_id = "session-value-receipt-timeout"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="action",
            value="9",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="invoke",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        with patch("trainerdeck_runtime.COMMAND_TIMEOUT_SECONDS", 0.05):
            request_task = asyncio.create_task(
                self.manager.set_option_value(
                    1234,
                    session_id,
                    "N1",
                    "10",
                    "9",
                    snapshot["revision"],
                )
            )
            value_command = await _read_frame(reader)
            await self.publish_menu(
                writer,
                session_id,
                2,
                False,
                kind="action",
                value="10",
                value_controllable=True,
                value_type="integer",
                value_apply_mode="invoke",
            )
            await _write_frame(
                writer,
                {
                    "type": "command_accepted",
                    "session_id": session_id,
                    "request_id": value_command["request_id"],
                    "status": "staged",
                    "operation": "value",
                    "invoked": False,
                },
            )
            with self.assertRaisesRegex(TrainerRuntimeError, "超时"):
                await request_task
        failed = self.manager.get_snapshot(1234)["options"][0]
        self.assertFalse(failed["value_pending"])
        self.assertIn("超时", failed["value_error"])
        writer.close()
        await writer.wait_closed()

    async def test_matching_toggle_is_an_immediate_noop(self):
        session_id = "session-toggle-noop"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(writer, session_id, 1, False)
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        result = await asyncio.wait_for(
            self.manager.set_option(
                1234,
                session_id,
                "N1",
                False,
                snapshot["revision"],
            ),
            timeout=0.1,
        )
        self.assertFalse(result["options"][0]["pending"])
        self.assertFalse(result["options"][0]["active"])
        writer.close()
        await writer.wait_closed()

    async def test_pure_action_completes_on_applied_acceptance(self):
        session_id = "session-action-applied"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            None,
            kind="action",
            action_controllable=True,
            value_type="none",
            value_apply_mode="none",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        option = snapshot["options"][0]
        self.assertTrue(option["action_controllable"])
        self.assertFalse(option["controllable"])
        self.assertFalse(option["value_controllable"])
        self.assertIsNone(option["active"])
        self.assertNotIn("value", option)

        request_task = asyncio.create_task(
            self.manager.invoke_option_action(
                1234,
                session_id,
                "N1",
                snapshot["revision"],
            )
        )
        command = await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        self.assertTrue(pending["options"][0]["action_pending"])
        self.assertFalse(pending["options"][0]["pending"])
        self.assertFalse(pending["options"][0]["value_pending"])
        self.assertFalse(request_task.done())
        self.assertEqual(command["type"], "action_command")
        self.assertEqual(command["option_id"], "N1")
        self.assertEqual(command["expected_bridge_revision"], 1)
        self.assertNotIn("desired", command)
        self.assertNotIn("value", command)

        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
                "status": "applied",
            },
        )
        applied = (await request_task)["options"][0]
        self.assertEqual(applied["action_error"], "")
        self.assertIsNone(applied["active"])
        self.assertNotIn("value", applied)
        writer.close()
        await writer.wait_closed()

    async def test_pure_action_accepts_legacy_invoked_receipt(self):
        session_id = "session-action-legacy"
        reader, writer = await self.connect_bridge(
            session_id=session_id,
            bridge_version="0.4.1",
        )
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            None,
            kind="action",
            action_controllable=True,
            value_type="none",
            value_apply_mode="none",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.invoke_option_action(
                1234,
                session_id,
                "N1",
                snapshot["revision"],
            )
        )
        command = await _read_frame(reader)
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
                "operation": "action",
                "invoked": True,
            },
        )
        applied = (await request_task)["options"][0]
        self.assertFalse(applied["action_pending"])
        self.assertEqual(applied["action_error"], "")
        writer.close()
        await writer.wait_closed()

    async def test_pure_action_rejection_sets_only_action_error(self):
        session_id = "session-action-rejected"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            None,
            kind="action",
            action_controllable=True,
            value_type="none",
            value_apply_mode="none",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.invoke_option_action(
                1234,
                session_id,
                "N1",
                snapshot["revision"],
            )
        )
        command = await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        self.assertTrue(pending["options"][0]["action_pending"])
        self.assertFalse(request_task.done())
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
                "status": "queued",
            },
        )
        await asyncio.sleep(0.02)
        self.assertTrue(
            self.manager.get_snapshot(1234)["options"][0]["action_pending"]
        )
        await _write_frame(
            writer,
            {
                "type": "command_error",
                "session_id": session_id,
                "request_id": command["request_id"],
                "message": "动作不可用",
            },
        )
        with self.assertRaisesRegex(TrainerRuntimeError, "动作不可用"):
            await request_task
        rejected = self.manager.get_snapshot(1234)["options"][0]
        self.assertFalse(rejected["action_pending"])
        self.assertEqual(rejected["action_error"], "动作不可用")
        self.assertEqual(rejected["error"], "")
        self.assertEqual(rejected["value_error"], "")
        writer.close()
        await writer.wait_closed()

    async def test_action_pending_blocks_other_commands_and_disconnect_clears_it(self):
        session_id = "session-action-disconnect"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            None,
            kind="action",
            action_controllable=True,
            value_type="none",
            value_apply_mode="none",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.invoke_option_action(
                1234,
                session_id,
                "N1",
                snapshot["revision"],
            )
        )
        await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        self.assertTrue(pending["options"][0]["action_pending"])
        self.assertFalse(request_task.done())

        # A valid bridge contract never exposes these three controls together.
        # Make the other control gates reachable to assert that action_pending
        # itself still serializes all commands for the same opaque option ID.
        internal_option = self.manager._sessions[1234]["options"][0]
        internal_option["controllable"] = True
        internal_option["active"] = False
        internal_option["value_controllable"] = True
        internal_option["value"] = "1"
        internal_option["value_type"] = "integer"
        internal_option["value_apply_mode"] = "invoke"
        current_revision = self.manager.get_snapshot(1234)["revision"]
        with self.assertRaises(TrainerRuntimeError):
            await self.manager.set_option(
                1234,
                session_id,
                "N1",
                True,
                current_revision,
            )
        with self.assertRaises(TrainerRuntimeError):
            await self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "2",
                "1",
                current_revision,
            )

        writer.close()
        await writer.wait_closed()
        with self.assertRaisesRegex(TrainerRuntimeError, "断开"):
            await request_task
        await self.wait_until(
            lambda: not self.manager.get_snapshot(1234)["connected"]
        )
        disconnected = self.manager.get_snapshot(1234)["options"][0]
        self.assertFalse(disconnected["action_pending"])
        self.assertIn("断开", disconnected["action_error"])
        self.assertFalse(disconnected["pending"])
        self.assertFalse(disconnected["value_pending"])

    async def test_value_command_validates_number_bounds_and_expected_value(self):
        session_id = "session-value-validate"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="toggle_with_input",
            value="5",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
            minimum=1,
            maximum=9,
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        revision = self.manager.get_snapshot(1234)["revision"]

        for invalid in (
            "",
            "nan",
            "inf",
            "-inf",
            "not-a-number",
            "1.5",
        ):
            with self.assertRaises(TrainerRuntimeError):
                await self.manager.set_option_value(
                    1234,
                    session_id,
                    "N1",
                    invalid,
                    "5",
                    revision,
                )
        for outside in ("0", "10"):
            with self.assertRaises(TrainerRuntimeError):
                await self.manager.set_option_value(
                    1234,
                    session_id,
                    "N1",
                    outside,
                    "5",
                    revision,
                )
        with self.assertRaises(TrainerRuntimeError):
            await self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "6",
                "4",
                revision,
            )
        with self.assertRaises(TrainerRuntimeError):
            await self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "1" * 201,
                "5",
                revision,
            )
        writer.close()
        await writer.wait_closed()

    async def test_invoke_value_command_is_sent_even_when_value_is_unchanged(self):
        session_id = "session-value-invoke"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="action",
            value="999",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="invoke",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "999",
                "999",
                snapshot["revision"],
            )
        )
        command = await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        self.assertTrue(pending["options"][0]["value_pending"])
        self.assertFalse(request_task.done())
        self.assertEqual(command["type"], "value_command")
        self.assertEqual(command["value"], "999")
        self.assertEqual(command["expected_value"], "999")
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
                "status": "staged",
                "operation": "value",
                "invoked": False,
            },
        )
        await self.publish_menu(
            writer,
            session_id,
            2,
            False,
            kind="action",
            value="999",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="invoke",
        )
        await asyncio.sleep(0.02)
        self.assertFalse(request_task.done())
        await _write_frame(
            writer,
            {
                "type": "command_accepted",
                "session_id": session_id,
                "request_id": command["request_id"],
                "status": "applied",
                "operation": "value",
                "invoked": True,
            },
        )
        confirmed = await request_task
        self.assertFalse(confirmed["options"][0]["value_pending"])
        writer.close()
        await writer.wait_closed()

    async def test_disconnect_clears_value_pending_with_value_error(self):
        session_id = "session-value-disconnect"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(
            writer,
            session_id,
            1,
            False,
            kind="toggle_with_input",
            value="5",
            value_controllable=True,
            value_type="integer",
            value_apply_mode="stage_then_toggle",
        )
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        snapshot = self.manager.get_snapshot(1234)
        request_task = asyncio.create_task(
            self.manager.set_option_value(
                1234,
                session_id,
                "N1",
                "6",
                "5",
                snapshot["revision"],
            )
        )
        await _read_frame(reader)
        pending = self.manager.get_snapshot(1234)
        self.assertTrue(pending["options"][0]["value_pending"])
        self.assertFalse(request_task.done())
        writer.close()
        await writer.wait_closed()
        with self.assertRaisesRegex(TrainerRuntimeError, "断开"):
            await request_task
        await self.wait_until(
            lambda: not self.manager.get_snapshot(1234)["connected"]
        )
        disconnected = self.manager.get_snapshot(1234)["options"][0]
        self.assertFalse(disconnected["value_pending"])
        self.assertIsNone(disconnected["desired_value"])
        self.assertIn("断开", disconnected["value_error"])

    async def test_disconnect_marks_state_unavailable_not_disabled(self):
        session_id = "session-test-5678"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(writer, session_id, 1, True)
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        writer.close()
        await writer.wait_closed()
        await self.wait_until(
            lambda: not self.manager.get_snapshot(1234)["connected"]
        )
        snapshot = self.manager.get_snapshot(1234)
        self.assertEqual(snapshot["status"], "disconnected")
        self.assertIsNone(snapshot["options"][0]["active"])

    async def test_stale_snapshot_is_ignored_and_timeout_preserves_state(self):
        session_id = "session-test-stale"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(writer, session_id, 2, False)
        await self.wait_until(
            lambda: self.manager.get_snapshot(1234)["bridge_revision"] == 2
        )
        await self.publish_menu(writer, session_id, 1, True)
        await asyncio.sleep(0.05)
        snapshot = self.manager.get_snapshot(1234)
        self.assertEqual(snapshot["bridge_revision"], 2)
        self.assertFalse(snapshot["options"][0]["active"])

        with patch("trainerdeck_runtime.COMMAND_TIMEOUT_SECONDS", 0.05):
            request_task = asyncio.create_task(
                self.manager.set_option(
                    1234,
                    session_id,
                    "N1",
                    True,
                    snapshot["revision"],
                )
            )
            await _read_frame(reader)
            pending = self.manager.get_snapshot(1234)
            self.assertTrue(pending["options"][0]["pending"])
            self.assertFalse(request_task.done())
            with self.assertRaisesRegex(TrainerRuntimeError, "超时"):
                await request_task
        timed_out = self.manager.get_snapshot(1234)["options"][0]
        self.assertFalse(timed_out["active"])
        self.assertIn("超时", timed_out["error"])
        writer.close()
        await writer.wait_closed()

    async def test_unprepared_app_and_wrong_session_are_rejected(self):
        reader, writer = await asyncio.open_connection(
            "127.0.0.1",
            self.manager.port,
        )
        await _write_frame(
            writer,
            {
                "type": "hello",
                "protocol": 1,
                "token": self.manifest["token"],
                "app_id": 9999,
                "session_id": "session-unprepared",
                "trainer_sha256": self.prepared["trainer_sha256"],
            },
        )
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(reader), timeout=1.0)
        writer.close()
        await writer.wait_closed()

        reader, writer = await self.connect_bridge(
            session_id="session-correct-1234"
        )
        await _read_frame(reader)
        await _write_frame(
            writer,
            {
                "type": "heartbeat",
                "session_id": "session-wrong-1234",
            },
        )
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(reader), timeout=1.0)
        writer.close()
        await writer.wait_closed()

    async def test_reprepare_invalidates_the_old_trainer_session(self):
        old_token = self.manifest["token"]
        session_id = "session-before-reprepare"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(writer, session_id, 1, False)
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )
        old_snapshot = self.manager.get_snapshot(1234)

        prepared = self.manager.prepare_bridge(1234, self.installation)
        refreshed_manifest = json.loads(
            Path(prepared["manifest"]).read_text(encoding="utf-8")
        )
        self.assertNotEqual(refreshed_manifest["token"], old_token)
        await self.manager.invalidate_app(1234)
        await self.wait_until(
            lambda: self.manager.get_snapshot(1234)["status"] == "waiting"
        )
        snapshot = self.manager.get_snapshot(1234)
        self.assertFalse(snapshot["connected"])
        self.assertEqual(snapshot["options"], [])
        self.assertEqual(snapshot["epoch"], old_snapshot["epoch"])
        self.assertGreater(snapshot["revision"], old_snapshot["revision"])
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(reader), timeout=1.0)
        writer.close()
        await writer.wait_closed()

        new_session_id = "session-after-reprepare"
        new_reader, new_writer = await self.connect_bridge(
            token=refreshed_manifest["token"],
            session_id=new_session_id,
        )
        await _read_frame(new_reader)
        await self.publish_menu(new_writer, new_session_id, 1, True)
        await self.wait_until(
            lambda: self.manager.get_snapshot(1234)["connected"]
            and bool(self.manager.get_snapshot(1234)["options"])
        )
        reconnected = self.manager.get_snapshot(1234)
        self.assertGreater(reconnected["revision"], snapshot["revision"])
        self.assertTrue(reconnected["options"][0]["active"])
        new_writer.close()
        await new_writer.wait_closed()

    async def test_revoke_leaves_inert_manifest_and_rejects_old_token(self):
        token = self.manifest["token"]
        session_id = "session-before-revoke"
        reader, writer = await self.connect_bridge(session_id=session_id)
        await _read_frame(reader)
        await self.publish_menu(writer, session_id, 1, False)
        await self.wait_until(
            lambda: bool(self.manager.get_snapshot(1234)["options"])
        )

        await self.manager.revoke_app(1234)
        snapshot = self.manager.get_snapshot(1234)
        self.assertEqual(snapshot["status"], "not_prepared")
        self.assertFalse(snapshot["connected"])
        self.assertTrue(Path(self.prepared["manifest"]).is_file())
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(reader), timeout=1.0)
        writer.close()
        await writer.wait_closed()

        rejected_reader, rejected_writer = await asyncio.open_connection(
            "127.0.0.1",
            self.manager.port,
        )
        await _write_frame(
            rejected_writer,
            {
                "type": "hello",
                "protocol": 1,
                "token": token,
                "app_id": 1234,
                "session_id": "session-after-revoke",
                "trainer_sha256": self.prepared["trainer_sha256"],
            },
        )
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(rejected_reader), timeout=1.0)
        rejected_writer.close()
        await rejected_writer.wait_closed()

    async def test_invalid_token_and_oversized_frame_are_rejected(self):
        reader, writer = await self.connect_bridge(token="wrong")
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(reader), timeout=1.0)
        writer.close()
        await writer.wait_closed()

        reader, writer = await asyncio.open_connection(
            "127.0.0.1",
            self.manager.port,
        )
        writer.write(struct.pack("<I", MAX_FRAME_BYTES + 1))
        await writer.drain()
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(_read_frame(reader), timeout=1.0)
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    unittest.main()
