"""Backend core for TrainerDeck.

The module deliberately uses only Python's standard library so that the Decky
runtime does not need pip packages. Network providers are isolated from
installation and binding logic to keep site-specific changes replaceable.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import ssl
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


PLUGIN_VERSION = "0.6.9"
SCHEMA_VERSION = 3
SETTINGS_FILENAME = "settings.json"
BINDINGS_FILENAME = "bindings.json"
METADATA_FILENAME = "trainerdeck.json"
OFFICIAL_HOSTS = {"flingtrainer.com", "www.flingtrainer.com"}
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    f"(KHTML, like Gecko) TrainerDeck/{PLUGIN_VERSION}"
)
MAX_REMOTE_TEXT_BYTES = 20 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILES = 1000
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
SYSTEM_CA_BUNDLES = (
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
)
_SSL_CONTEXT: ssl.SSLContext | None = None

class TrainerDeckError(RuntimeError):
    """A user-facing backend failure."""


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return copy.deepcopy(default)
    except (OSError, json.JSONDecodeError):
        return copy.deepcopy(default)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_component(value: str, fallback: str = "trainer") -> str:
    cleaned = unicodedata.normalize("NFKC", str(value))
    cleaned = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return (cleaned[:100] or fallback).strip()


def _normal_search_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.findall(r"[\w]+", normalized, flags=re.UNICODE))


def _stable_id(*parts: str, length: int = 16) -> str:
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()
    return digest[:length]


def _trusted_ssl_context() -> ssl.SSLContext:
    """Use Decky's CA bundle, with verified system/default fallbacks."""

    global _SSL_CONTEXT
    if _SSL_CONTEXT is not None:
        return _SSL_CONTEXT

    candidates = [
        os.environ.get("SSL_CERT_FILE", ""),
        os.environ.get("REQUESTS_CA_BUNDLE", ""),
    ]
    try:
        # Decky Loader itself depends on certifi and uses the same bundle for
        # fetchNoCors. Keep this import lazy for non-Decky test environments.
        import certifi  # type: ignore[import-not-found]

        candidates.append(certifi.where())
    except (ImportError, OSError):
        pass
    candidates.extend(SYSTEM_CA_BUNDLES)

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        try:
            resolved = str(Path(candidate).expanduser().resolve())
            if resolved in seen or not Path(resolved).is_file():
                continue
            seen.add(resolved)
            _SSL_CONTEXT = ssl.create_default_context(cafile=resolved)
            return _SSL_CONTEXT
        except (OSError, ssl.SSLError):
            continue

    # This remains fully verified. If the frozen runtime has no usable trust
    # store, the request fails closed instead of disabling certificate checks.
    _SSL_CONTEXT = ssl.create_default_context()
    return _SSL_CONTEXT


_HTML_ENTITIES = {
    "amp": "&",
    "apos": "'",
    "copy": "\u00a9",
    "divide": "\u00f7",
    "gt": ">",
    "hellip": "\u2026",
    "laquo": "\u00ab",
    "ldquo": "\u201c",
    "lsquo": "\u2018",
    "lt": "<",
    "mdash": "\u2014",
    "middot": "\u00b7",
    "nbsp": "\u00a0",
    "ndash": "\u2013",
    "plusmn": "\u00b1",
    "quot": '"',
    "raquo": "\u00bb",
    "rdquo": "\u201d",
    "reg": "\u00ae",
    "rsquo": "\u2019",
    "times": "\u00d7",
    "trade": "\u2122",
}
_HTML_CHARREF_RE = re.compile(
    r"&(?:#(?P<decimal>[0-9]{1,8})|#[xX](?P<hex>[0-9A-Fa-f]{1,8})|"
    r"(?P<named>[A-Za-z][A-Za-z0-9]{1,31}));?"
)
_WINDOWS_1252_CHARREFS = {
    0x80: "\u20ac",
    0x82: "\u201a",
    0x83: "\u0192",
    0x84: "\u201e",
    0x85: "\u2026",
    0x86: "\u2020",
    0x87: "\u2021",
    0x88: "\u02c6",
    0x89: "\u2030",
    0x8A: "\u0160",
    0x8B: "\u2039",
    0x8C: "\u0152",
    0x8E: "\u017d",
    0x91: "\u2018",
    0x92: "\u2019",
    0x93: "\u201c",
    0x94: "\u201d",
    0x95: "\u2022",
    0x96: "\u2013",
    0x97: "\u2014",
    0x98: "\u02dc",
    0x99: "\u2122",
    0x9A: "\u0161",
    0x9B: "\u203a",
    0x9C: "\u0153",
    0x9E: "\u017e",
    0x9F: "\u0178",
}


def _decode_html_charrefs(value: str) -> str:
    """Decode the character references used by FLiNG without importing html.*."""

    def replace(match: re.Match[str]) -> str:
        named = match.group("named")
        if named is not None:
            return _HTML_ENTITIES.get(named.casefold(), match.group(0))

        raw_number = match.group("hex") or match.group("decimal") or ""
        radix = 16 if match.group("hex") is not None else 10
        try:
            codepoint = int(raw_number, radix)
        except ValueError:
            return match.group(0)
        if codepoint in _WINDOWS_1252_CHARREFS:
            return _WINDOWS_1252_CHARREFS[codepoint]
        if codepoint == 0 or codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF:
            return "\ufffd"
        return chr(codepoint)

    return _HTML_CHARREF_RE.sub(replace, value)


def _tag_end(markup: str, start: int) -> int:
    """Return the closing > while respecting quotes inside a tag."""

    quote = ""
    for index in range(start + 1, len(markup)):
        character = markup[index]
        if quote:
            if character == quote:
                quote = ""
        elif character in {'"', "'"}:
            quote = character
        elif character == ">":
            return index
    return -1


def _tag_attributes(source: str) -> list[tuple[str, str | None]]:
    attributes: list[tuple[str, str | None]] = []
    position = 0
    while position < len(source):
        while position < len(source) and source[position].isspace():
            position += 1
        if position >= len(source):
            break

        name_start = position
        while (
            position < len(source)
            and not source[position].isspace()
            and source[position] not in "=/<>"
        ):
            position += 1
        if position == name_start:
            position += 1
            continue
        name = source[name_start:position].casefold()
        while position < len(source) and source[position].isspace():
            position += 1

        value: str | None = None
        if position < len(source) and source[position] == "=":
            position += 1
            while position < len(source) and source[position].isspace():
                position += 1
            if position < len(source) and source[position] in {'"', "'"}:
                quote = source[position]
                position += 1
                value_start = position
                while position < len(source) and source[position] != quote:
                    position += 1
                value = source[value_start:position]
                if position < len(source):
                    position += 1
            else:
                value_start = position
                while position < len(source) and not source[position].isspace():
                    position += 1
                value = source[value_start:position]
            value = _decode_html_charrefs(value)
        attributes.append((name, value))
    return attributes


class _LightweightHTMLParser:
    """Small, forgiving HTML tokenizer for the two FLiNG extractors below."""

    RAW_TEXT_TAGS = {"script", "style"}
    TAG_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9:._-]*")

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        pass

    def handle_data(self, data: str) -> None:
        pass

    def handle_endtag(self, tag: str) -> None:
        pass

    def feed(self, markup: str) -> None:
        position = 0
        while position < len(markup):
            tag_start = markup.find("<", position)
            if tag_start < 0:
                self.handle_data(_decode_html_charrefs(markup[position:]))
                return
            if tag_start > position:
                self.handle_data(_decode_html_charrefs(markup[position:tag_start]))

            if markup.startswith("<!--", tag_start):
                comment_end = markup.find("-->", tag_start + 4)
                if comment_end < 0:
                    return
                position = comment_end + 3
                continue

            end = _tag_end(markup, tag_start)
            if end < 0:
                self.handle_data(_decode_html_charrefs(markup[tag_start:]))
                return

            body = markup[tag_start + 1 : end].strip()
            if not body or body[0] in "!?":
                position = end + 1
                continue

            if body.startswith("/"):
                match = self.TAG_NAME_RE.match(body.lstrip("/ "))
                if match:
                    self.handle_endtag(match.group(0).casefold())
                    position = end + 1
                    continue
            else:
                match = self.TAG_NAME_RE.match(body)
                if match:
                    tag = match.group(0).casefold()
                    trailing_slash = len(body.rstrip()) - 1
                    slash_is_separator = (
                        trailing_slash >= match.end()
                        and body[trailing_slash] == "/"
                        and (
                            trailing_slash == match.end()
                            or body[trailing_slash - 1].isspace()
                            or body[trailing_slash - 1] in {'"', "'"}
                        )
                    )
                    attribute_source = body[match.end() :]
                    if slash_is_separator:
                        attribute_source = body[match.end() : trailing_slash]
                    self.handle_starttag(tag, _tag_attributes(attribute_source))
                    position = end + 1
                    if slash_is_separator:
                        self.handle_endtag(tag)
                    elif tag in self.RAW_TEXT_TAGS:
                        closing = re.search(
                            rf"</\s*{re.escape(tag)}\s*>",
                            markup[position:],
                            flags=re.IGNORECASE,
                        )
                        if closing is None:
                            self.handle_data(markup[position:])
                            return
                        self.handle_data(markup[position : position + closing.start()])
                        self.handle_endtag(tag)
                        position += closing.end()
                    continue

            # A malformed tag-like fragment is text, not a reason to drop the page.
            self.handle_data(_decode_html_charrefs(markup[tag_start : end + 1]))
            position = end + 1


class _AnchorParser(_LightweightHTMLParser):
    def __init__(self) -> None:
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() == "a" and self._href is None:
            attributes = dict(attrs)
            self._href = attributes.get("href")
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "a" and self._href is not None:
            text = re.sub(r"\s+", " ", " ".join(self._text)).strip()
            self.links.append((self._href, text))
            self._href = None
            self._text = []


class _TrainerPageParser(_AnchorParser):
    BLOCK_TAGS = {
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "section",
        "td",
        "tr",
    }
    IGNORED_TAGS = {"noscript", "script", "style", "svg", "template"}

    def __init__(self) -> None:
        super().__init__()
        self.text_parts: list[str] = []
        self._ignored_tags: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.casefold()
        if self._ignored_tags:
            if lowered in self.IGNORED_TAGS:
                self._ignored_tags.append(lowered)
            return
        if lowered in self.IGNORED_TAGS:
            self._ignored_tags.append(lowered)
            return
        super().handle_starttag(tag, attrs)
        if lowered == "br":
            self.text_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._ignored_tags:
            return
        super().handle_data(data)
        if data.strip():
            self.text_parts.append(data.strip())

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.casefold()
        if self._ignored_tags:
            if lowered in self._ignored_tags:
                ignored_index = len(self._ignored_tags) - 1 - self._ignored_tags[::-1].index(
                    lowered
                )
                del self._ignored_tags[ignored_index:]
            return
        super().handle_endtag(tag)
        if lowered in self.BLOCK_TAGS:
            self.text_parts.append("\n")

    def lines(self) -> list[str]:
        joined = " ".join(self.text_parts)
        joined = re.sub(r"[ \t]*\n[ \t]*", "\n", joined)
        return [
            re.sub(r"\s+", " ", line).strip()
            for line in joined.splitlines()
            if line.strip()
        ]


class TrainerDeckCore:
    def __init__(
        self,
        settings_dir: str | Path,
        runtime_dir: str | Path,
        user_home: str | Path,
        user_name: str = "deck",
    ) -> None:
        self.settings_dir = Path(settings_dir).resolve()
        self.runtime_dir = Path(runtime_dir).resolve()
        self.user_home = Path(user_home).resolve()
        self.user_name = user_name
        self.settings_path = self.settings_dir / SETTINGS_FILENAME
        self.bindings_path = self.settings_dir / BINDINGS_FILENAME
        self.settings_dir.mkdir(parents=True, exist_ok=True)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)

    def _defaults(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "trainer_root": str(self.user_home / "Downloads" / "trainer"),
            "auto_search_and_add": False,
            "restore_input_on_qam_close": False,
        }

    def get_settings(self) -> dict[str, Any]:
        loaded = _read_json(self.settings_path, self._defaults())
        if not isinstance(loaded, dict):
            loaded = {}
        merged = self._defaults()
        merged.update({key: loaded[key] for key in merged if key in loaded})
        try:
            loaded_schema = int(loaded.get("schema_version", 0))
        except (TypeError, ValueError):
            loaded_schema = 0
        legacy_defaults = {
            str(self.user_home / "Documents" / "TrainerDeck"),
            str(self.user_home / "trainer"),
        }
        if (
            loaded_schema < SCHEMA_VERSION
            and merged.get("trainer_root") in legacy_defaults
        ):
            legacy_root = Path(str(merged["trainer_root"]))
            has_existing_trainers = legacy_root.is_dir() and any(
                legacy_root.rglob(METADATA_FILENAME)
            )
            if not has_existing_trainers:
                merged["trainer_root"] = self._defaults()["trainer_root"]
        merged["schema_version"] = SCHEMA_VERSION
        try:
            self._validated_trainer_root(merged["trainer_root"]).mkdir(
                parents=True,
                exist_ok=True,
            )
        except (OSError, TrainerDeckError):
            pass
        return merged

    def _allowed_trainer_roots(self) -> list[Path]:
        roots = [self.user_home, self.runtime_dir]
        if os.name != "nt":
            roots.append(Path("/run/media") / self.user_name)
        return [root.resolve() for root in roots]

    def _validated_trainer_root(self, value: Any) -> Path:
        if not isinstance(value, str) or not value.strip():
            raise TrainerDeckError("修改器目录不能为空")
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            raise TrainerDeckError("修改器目录必须是绝对路径")
        resolved = candidate.resolve()
        if not any(_is_within(resolved, root) for root in self._allowed_trainer_roots()):
            allowed = "、".join(str(root) for root in self._allowed_trainer_roots())
            raise TrainerDeckError(f"目录必须位于以下可写位置之一：{allowed}")
        return resolved

    def save_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(settings, dict):
            raise TrainerDeckError("设置格式无效")
        current = self.get_settings()
        if "trainer_root" in settings:
            current["trainer_root"] = str(
                self._validated_trainer_root(settings["trainer_root"])
            )
        if "auto_search_and_add" in settings:
            if not isinstance(settings["auto_search_and_add"], bool):
                raise TrainerDeckError("auto_search_and_add 必须是布尔值")
            current["auto_search_and_add"] = settings[
                "auto_search_and_add"
            ]
        if "restore_input_on_qam_close" in settings:
            if not isinstance(settings["restore_input_on_qam_close"], bool):
                raise TrainerDeckError(
                    "restore_input_on_qam_close 必须是布尔值"
                )
            current["restore_input_on_qam_close"] = settings[
                "restore_input_on_qam_close"
            ]
        current["schema_version"] = SCHEMA_VERSION
        Path(current["trainer_root"]).mkdir(parents=True, exist_ok=True)
        _atomic_write_json(self.settings_path, current)
        return current

    @staticmethod
    def _request(url: str, timeout: int = 20) -> urllib.response.addinfourl:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            },
        )
        return urllib.request.urlopen(
            request,
            timeout=timeout,
            context=_trusted_ssl_context(),
        )

    @classmethod
    def _fetch_text(
        cls,
        url: str,
        max_bytes: int = MAX_REMOTE_TEXT_BYTES,
        timeout: int = 12,
    ) -> str:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise TrainerDeckError("只允许读取 HTTPS 地址")
        try:
            with cls._request(url, timeout=timeout) as response:
                data = response.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise TrainerDeckError("远程响应超过大小上限")
                charset = response.headers.get_content_charset() or "utf-8"
                return data.decode(charset, errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise TrainerDeckError(f"网络请求失败：{error}") from error

    @staticmethod
    def _official_url(url: str) -> bool:
        try:
            parsed = urllib.parse.urlparse(url)
            return parsed.scheme == "https" and parsed.hostname in OFFICIAL_HOSTS
        except ValueError:
            return False

    def _search_official(self, query: str) -> list[dict[str, Any]]:
        search_url = "https://flingtrainer.com/?" + urllib.parse.urlencode(
            {"s": query}
        )
        parser = _AnchorParser()
        parser.feed(self._fetch_text(search_url))
        query_text = _normal_search_text(query)
        query_tokens = set(query_text.split())
        candidates: list[tuple[int, dict[str, Any]]] = []
        seen: set[str] = set()

        for raw_href, raw_title in parser.links:
            try:
                href = urllib.parse.urljoin(search_url, raw_href)
                parsed = urllib.parse.urlparse(href)
            except ValueError:
                continue
            title = raw_title.strip()
            if (
                not self._official_url(href)
                or "/trainer/" not in parsed.path
                or "trainer" not in title.casefold()
                or href in seen
            ):
                continue
            seen.add(href)
            game_name = re.sub(
                r"\s*[-–—]?\s*trainer.*$",
                "",
                title,
                flags=re.IGNORECASE,
            ).strip()
            searchable = _normal_search_text(game_name)
            searchable_tokens = set(searchable.split())
            overlap = len(query_tokens & searchable_tokens)
            coverage = overlap / max(1, len(query_tokens))
            if query_text == searchable:
                score = 1000
            elif query_text and query_text in searchable:
                score = 500
            else:
                score = 100 * overlap
            if query_tokens and coverage < 0.6:
                continue
            candidates.append(
                (
                    score,
                    {
                        "id": _stable_id("fling-official", href),
                        "provider": "fling-official",
                        "game_name": game_name or title,
                        "title": title,
                        "version": "",
                        "page_url": href,
                        "download_url": "",
                    },
                )
            )

        candidates.sort(key=lambda item: (-item[0], item[1]["title"]))
        return [entry for _, entry in candidates[:12]]

    def search_trainers(self, query: str) -> dict[str, Any]:
        query = re.sub(r"\s+", " ", str(query)).strip()[:120]
        if len(query) < 2:
            raise TrainerDeckError("搜索词至少需要 2 个字符")
        warnings: list[str] = []
        entries: list[dict[str, Any]] = []

        try:
            entries.extend(self._search_official(query))
        except TrainerDeckError as error:
            warnings.append(f"FLiNG 官方站搜索失败：{error}")

        deduplicated: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in entries:
            identity = entry.get("page_url") or entry.get("download_url") or entry["id"]
            if identity in seen:
                continue
            seen.add(identity)
            deduplicated.append(entry)
            if len(deduplicated) >= 20:
                break
        if not deduplicated and not re.search(r"[A-Za-z]", query):
            warnings.append(
                "FLiNG 官方索引使用英文游戏名；请使用 Steam 英文名搜索"
            )
        return {"items": deduplicated, "warnings": warnings}

    def _page_details(self, entry: dict[str, Any]) -> dict[str, Any]:
        page_url = str(entry.get("page_url") or "")
        if not self._official_url(page_url):
            raise TrainerDeckError("官方页面地址无效")
        parser = _TrainerPageParser()
        parser.feed(self._fetch_text(page_url))

        downloads: list[tuple[str, str]] = []
        for raw_href, title in parser.links:
            try:
                href = urllib.parse.urljoin(page_url, raw_href)
                parsed = urllib.parse.urlparse(href)
            except ValueError:
                continue
            if (
                self._official_url(href)
                and parsed.path.startswith("/downloads/")
                and href not in {item[0] for item in downloads}
            ):
                downloads.append((href, title))
        if not downloads:
            raise TrainerDeckError("页面中没有找到可下载的独立修改器")

        version = str(entry.get("version") or "")
        for line in parser.lines():
            if not version:
                version_match = re.search(
                    r"Game Version:\s*(.+?)(?:\s*[·|]\s*|$)",
                    line,
                    flags=re.IGNORECASE,
                )
                if version_match:
                    version = version_match.group(1).strip()

        download_url, download_title = downloads[0]
        detailed = copy.deepcopy(entry)
        detailed["download_url"] = download_url
        detailed["download_name"] = download_title
        detailed["version"] = version
        return detailed

    @staticmethod
    def _content_disposition_name(response: Any) -> str:
        try:
            return response.headers.get_filename() or ""
        except (AttributeError, KeyError, TypeError):
            return ""

    def _download_to_file(
        self,
        url: str,
        destination: Path,
        max_bytes: int,
        official_only: bool,
    ) -> tuple[str, str, str]:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise TrainerDeckError("下载地址必须使用 HTTPS")
        if official_only and not self._official_url(url):
            raise TrainerDeckError("官方来源跳转到了非官方域名")

        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/octet-stream,application/zip,*/*;q=0.8",
                "Referer": "https://flingtrainer.com/",
            },
        )
        digest = hashlib.sha256()
        written = 0
        try:
            with urllib.request.urlopen(
                request,
                timeout=45,
                context=_trusted_ssl_context(),
            ) as response:
                final_url = response.geturl()
                if urllib.parse.urlparse(final_url).scheme != "https":
                    raise TrainerDeckError("下载重定向到了非 HTTPS 地址")
                if official_only and not self._official_url(final_url):
                    raise TrainerDeckError("官方来源跳转到了非官方域名")
                length_header = response.headers.get("Content-Length")
                if length_header and int(length_header) > max_bytes:
                    raise TrainerDeckError("文件超过安全下载大小上限")
                suggested_name = self._content_disposition_name(response)
                content_type = response.headers.get_content_type()
                with destination.open("wb") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > max_bytes:
                            raise TrainerDeckError("文件超过安全下载大小上限")
                        digest.update(chunk)
                        output.write(chunk)
                return suggested_name, content_type, digest.hexdigest()
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            destination.unlink(missing_ok=True)
            if isinstance(error, TrainerDeckError):
                raise
            raise TrainerDeckError(f"修改器下载失败：{error}") from error

    @staticmethod
    def _safe_extract_zip(archive: Path, destination: Path) -> None:
        with zipfile.ZipFile(archive) as zipped:
            members = zipped.infolist()
            if len(members) > MAX_ARCHIVE_FILES:
                raise TrainerDeckError("压缩包文件数量异常")
            total_size = 0
            for member in members:
                normalized_name = member.filename.replace("\\", "/")
                member_path = PurePosixPath(normalized_name)
                if (
                    member_path.is_absolute()
                    or ".." in member_path.parts
                    or re.match(r"^[A-Za-z]:", normalized_name)
                ):
                    raise TrainerDeckError("压缩包包含越界路径")
                mode = member.external_attr >> 16
                if (mode & 0o170000) == 0o120000:
                    raise TrainerDeckError("压缩包包含不允许的符号链接")
                total_size += member.file_size
                if total_size > MAX_UNPACKED_BYTES:
                    raise TrainerDeckError("压缩包解压后超过大小上限")
            zipped.extractall(destination)

    @staticmethod
    def _find_trainer_executable(root: Path) -> Path:
        executables = [
            path
            for path in root.rglob("*")
            if path.is_file() and path.suffix.casefold() == ".exe"
        ]
        if not executables:
            raise TrainerDeckError("下载内容中没有找到修改器 EXE")

        def rank(path: Path) -> tuple[int, int, str]:
            lowered = path.name.casefold()
            unwanted = any(
                word in lowered
                for word in ("unins", "uninstall", "updater", "crashreport")
            )
            trainer_named = "trainer" in lowered
            return (1 if unwanted else 0, 0 if trainer_named else 1, lowered)

        return sorted(executables, key=rank)[0]

    @staticmethod
    def _direct_executable_name(
        suggested_name: str,
        download_url: str,
        entry: dict[str, Any],
    ) -> str:
        """Choose a safe, meaningful filename for a directly downloaded PE."""

        def clean(value: Any, *, allow_extensionless: bool) -> str:
            raw = urllib.parse.unquote(str(value or "")).strip()
            leaf = raw.replace("\\", "/").rsplit("/", 1)[-1].strip()
            if not leaf:
                return ""
            lowered = leaf.casefold()
            if lowered.endswith(".exe"):
                leaf = leaf[:-4]
            elif "." in leaf and not allow_extensionless:
                return ""
            elif not allow_extensionless:
                return ""
            stem = _safe_component(leaf, fallback="")[:96].rstrip(" .")
            if not stem:
                return ""
            if stem.casefold() in {
                "con",
                "prn",
                "aux",
                "nul",
                "com1",
                "com2",
                "com3",
                "com4",
                "com5",
                "com6",
                "com7",
                "com8",
                "com9",
                "lpt1",
                "lpt2",
                "lpt3",
                "lpt4",
                "lpt5",
                "lpt6",
                "lpt7",
                "lpt8",
                "lpt9",
            }:
                stem = f"_{stem}"
            return f"{stem}.exe"

        parsed_path_name = ""
        try:
            parsed_path_name = PurePosixPath(
                urllib.parse.urlparse(download_url).path
            ).name
        except ValueError:
            pass

        strict_candidates = (suggested_name, parsed_path_name)
        for candidate in strict_candidates:
            cleaned = clean(candidate, allow_extensionless=False)
            if cleaned:
                return cleaned

        descriptive_candidates = (
            entry.get("download_name"),
            entry.get("title"),
            entry.get("game_name"),
        )
        for candidate in descriptive_candidates:
            cleaned = clean(candidate, allow_extensionless=True)
            if cleaned:
                return cleaned
        return "trainer.exe"

    def _prepare_payload(
        self,
        payload: Path,
        extract_root: Path,
        direct_executable_name: str = "trainer.exe",
    ) -> Path:
        if zipfile.is_zipfile(payload):
            self._safe_extract_zip(payload, extract_root)
            return self._find_trainer_executable(extract_root)

        with payload.open("rb") as payload_file:
            signature = payload_file.read(8)
        if signature[:2] == b"MZ":
            direct = extract_root / direct_executable_name
            if direct.parent != extract_root or direct.suffix.casefold() != ".exe":
                raise TrainerDeckError("下载文件名无效")
            shutil.copy2(payload, direct)
            return direct
        if signature.startswith(b"Rar!\x1a\x07"):
            raise TrainerDeckError("当前 MVP 尚不支持 RAR；请使用 ZIP 版本或先手动解压")
        raise TrainerDeckError("下载内容不是受支持的 ZIP 或 EXE")

    @staticmethod
    def _next_available(path: Path) -> Path:
        if not path.exists():
            return path
        for index in range(2, 1000):
            candidate = path.with_name(f"{path.name}-{index}")
            if not candidate.exists():
                return candidate
        raise TrainerDeckError("目标目录中存在过多同名版本")

    def download_trainer(self, raw_entry: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(raw_entry, dict):
            raise TrainerDeckError("搜索结果格式无效")
        entry = copy.deepcopy(raw_entry)
        provider = str(entry.get("provider") or "")
        if provider == "fling-official" or (
            entry.get("page_url") and not entry.get("download_url")
        ):
            entry = self._page_details(entry)

        download_url = str(entry.get("download_url") or "")
        if not download_url:
            raise TrainerDeckError("这个结果没有可用下载地址")
        settings = self.get_settings()
        trainer_root = self._validated_trainer_root(settings["trainer_root"])
        trainer_root.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(dir=self.runtime_dir) as temporary_name:
            temporary = Path(temporary_name)
            payload = temporary / "payload.bin"
            suggested_name, content_type, sha256 = self._download_to_file(
                download_url,
                payload,
                max_bytes=MAX_DOWNLOAD_BYTES,
                official_only=provider == "fling-official",
            )
            expected_hash = str(entry.get("sha256") or "").casefold()
            if expected_hash and expected_hash != sha256:
                raise TrainerDeckError("下载文件的 SHA-256 与预期值不一致")

            extract_root = temporary / "extracted"
            extract_root.mkdir()
            direct_executable_name = self._direct_executable_name(
                suggested_name,
                download_url,
                entry,
            )
            executable = self._prepare_payload(
                payload,
                extract_root,
                direct_executable_name,
            )
            relative_executable = executable.relative_to(extract_root)
            game_dir = trainer_root / _safe_component(
                str(entry.get("game_name") or entry.get("title") or "trainer")
            )
            version_name = _safe_component(
                str(
                    entry.get("version")
                    or entry.get("download_name")
                    or suggested_name
                    or entry.get("title")
                    or "latest"
                ),
                fallback="latest",
            )
            game_dir.mkdir(parents=True, exist_ok=True)
            target = self._next_available(game_dir / version_name)
            staging = target.with_name(f".{target.name}.{os.getpid()}.staging")
            shutil.copytree(extract_root, staging)

            installation_id = _stable_id(
                sha256,
                str(entry.get("game_name") or ""),
                str(entry.get("version") or ""),
                length=24,
            )
            metadata = {
                "schema_version": SCHEMA_VERSION,
                "id": installation_id,
                "provider": provider or "external",
                "game_name": str(entry.get("game_name") or entry.get("title") or ""),
                "title": str(entry.get("title") or entry.get("game_name") or ""),
                "version": str(entry.get("version") or ""),
                "page_url": str(entry.get("page_url") or ""),
                "download_url": download_url,
                "download_name": suggested_name
                or str(entry.get("download_name") or "")
                or direct_executable_name,
                "content_type": content_type,
                "sha256": sha256,
                "executable_relative": relative_executable.as_posix(),
                "installed_at": datetime.now(timezone.utc).isoformat(),
            }
            _atomic_write_json(staging / METADATA_FILENAME, metadata)
            os.replace(staging, target)

        return self._installation_record(target, metadata)

    @staticmethod
    def _installation_record(folder: Path, metadata: dict[str, Any]) -> dict[str, Any]:
        executable = folder / str(metadata.get("executable_relative") or "")
        public_fields = (
            "schema_version",
            "id",
            "provider",
            "game_name",
            "title",
            "version",
            "page_url",
            "download_url",
            "download_name",
            "content_type",
            "sha256",
            "executable_relative",
            "installed_at",
        )
        record = {
            field: copy.deepcopy(metadata[field])
            for field in public_fields
            if field in metadata
        }
        record["folder"] = str(folder)
        record["executable"] = str(executable)
        return record

    def list_installed(self) -> list[dict[str, Any]]:
        settings = self.get_settings()
        root = self._validated_trainer_root(settings["trainer_root"])
        if not root.exists():
            return []
        records: list[dict[str, Any]] = []
        for metadata_path in root.rglob(METADATA_FILENAME):
            metadata = _read_json(metadata_path, {})
            if not isinstance(metadata, dict) or not metadata.get("id"):
                continue
            record = self._installation_record(metadata_path.parent, metadata)
            if Path(record["executable"]).is_file():
                records.append(record)
        records.sort(
            key=lambda record: str(record.get("installed_at") or ""),
            reverse=True,
        )
        return records

    def get_installation(self, installation_id: str) -> dict[str, Any]:
        wanted = str(installation_id)
        installation = next(
            (
                item
                for item in self.list_installed()
                if item["id"] == wanted
            ),
            None,
        )
        if installation is None:
            raise TrainerDeckError("找不到已安装修改器")
        return installation

    def _bindings(self) -> dict[str, Any]:
        value = _read_json(self.bindings_path, {})
        return value if isinstance(value, dict) else {}

    def bind_trainer(
        self,
        app_id: int,
        installation_id: str,
        managed_launch_executable: str = "",
        original_launch_options: str | None = None,
        applied_launch_options: str = "",
        display_name: str = "",
        target_type: str = "",
        shortcut_exe: str = "",
        launch_options_field: str = "",
    ) -> dict[str, Any]:
        try:
            numeric_app_id = int(app_id)
        except (TypeError, ValueError) as error:
            raise TrainerDeckError("Steam AppID 无效") from error
        if numeric_app_id <= 0:
            raise TrainerDeckError("Steam AppID 无效")
        normalized_target_type = str(target_type or "").strip().casefold()
        if normalized_target_type and normalized_target_type not in {
            "steam",
            "shortcut",
        }:
            raise TrainerDeckError("Steam 目标类型无效")
        normalized_launch_options_field = str(
            launch_options_field or ""
        ).strip().casefold()
        if (
            normalized_launch_options_field
            and normalized_launch_options_field not in {"app", "shortcut"}
        ):
            raise TrainerDeckError("Steam 启动项字段无效")
        if (
            normalized_target_type == "steam"
            and normalized_launch_options_field == "shortcut"
        ):
            raise TrainerDeckError("Steam 游戏只能使用普通启动项字段")
        normalized_shortcut_exe = str(shortcut_exe or "").strip()
        if len(normalized_shortcut_exe) > 4096 or "\0" in normalized_shortcut_exe:
            raise TrainerDeckError("非 Steam 快捷方式路径无效")
        installation = self.get_installation(installation_id)
        managed_path = Path(
            managed_launch_executable or installation["executable"]
        ).resolve()
        folder = Path(installation["folder"]).resolve()
        allowed_paths = {
            Path(installation["executable"]).resolve(),
            (folder / "TrainerDeckBridgeLauncher.exe").resolve(),
        }
        if managed_path not in allowed_paths or not managed_path.is_file():
            raise TrainerDeckError("绑定的修改器启动路径无效")
        bindings = self._bindings()
        key = str(numeric_app_id)
        previous = bindings.get(key)
        previous = previous if isinstance(previous, dict) else {}
        previous_active = bool(previous.get("active", True))
        previous_target_type = str(previous.get("target_type") or "").casefold()
        previous_launch_options_field = str(
            previous.get("launch_options_field") or ""
        ).casefold()
        if (
            not normalized_target_type
            and previous_active
            and previous_target_type in {"steam", "shortcut"}
        ):
            normalized_target_type = previous_target_type
        if (
            not normalized_launch_options_field
            and previous_active
            and previous_launch_options_field in {"app", "shortcut"}
        ):
            normalized_launch_options_field = previous_launch_options_field
        if (
            normalized_target_type == "steam"
            and normalized_launch_options_field == "shortcut"
        ):
            raise TrainerDeckError("Steam 游戏只能使用普通启动项字段")
        if (
            not normalized_shortcut_exe
            and previous_active
            and isinstance(previous.get("shortcut_exe"), str)
        ):
            normalized_shortcut_exe = str(previous["shortcut_exe"])
        previous_candidates = (
            previous.get("candidate_launch_executables", [])
            if previous_active
            else []
        )
        if not isinstance(previous_candidates, list):
            previous_candidates = []
        candidate_paths = {
            str(path)
            for path in previous_candidates
            if isinstance(path, str) and path
        }
        candidate_paths.add(str(managed_path))
        record = {
            "installation_id": installation["id"],
            "managed_launch_executable": str(managed_path),
            "candidate_launch_executables": sorted(candidate_paths),
            "applied_launch_options": str(applied_launch_options or ""),
            "display_name": str(display_name or previous.get("display_name") or ""),
            "target_type": normalized_target_type or None,
            "launch_options_field": normalized_launch_options_field or None,
            "shortcut_exe": normalized_shortcut_exe,
            "bound_at": datetime.now(timezone.utc).isoformat(),
            "active": True,
            "launch_options_restored": False,
        }
        if isinstance(original_launch_options, str):
            record["original_launch_options"] = original_launch_options
        elif previous_active and isinstance(
            previous.get("original_launch_options"), str
        ):
            record["original_launch_options"] = previous[
                "original_launch_options"
            ]
        bindings[key] = record
        _atomic_write_json(self.bindings_path, bindings)
        return self.get_binding(numeric_app_id) or {
            **installation,
            "app_id": numeric_app_id,
            "managed_launch_executable": str(managed_path),
        }

    def get_binding(self, app_id: int) -> dict[str, Any] | None:
        try:
            key = str(int(app_id))
        except (TypeError, ValueError):
            return None
        value = self._bindings().get(key)
        if not isinstance(value, dict):
            return None
        if value.get("active", True) is False:
            return None
        installation_id = value.get("installation_id") or value.get("id")
        if not installation_id:
            return None
        try:
            installation = self.get_installation(str(installation_id))
        except TrainerDeckError:
            return None
        managed_value = str(value.get("managed_launch_executable") or "")
        legacy_missing_managed = not managed_value
        if legacy_missing_managed:
            legacy_launcher = (
                Path(installation["folder"]) / "TrainerDeckBridgeLauncher.exe"
            )
            managed_value = str(
                legacy_launcher
                if legacy_launcher.is_file()
                else Path(installation["executable"])
            )
        raw_candidates = value.get("candidate_launch_executables", [])
        if not isinstance(raw_candidates, list):
            raw_candidates = []
        candidate_paths = {
            str(path)
            for path in raw_candidates
            if isinstance(path, str) and path
        }
        candidate_paths.add(managed_value)
        if legacy_missing_managed:
            candidate_paths.add(
                str(Path(installation["executable"]).resolve())
            )
            candidate_paths.add(
                str(
                    (
                        Path(installation["folder"])
                        / "TrainerDeckBridgeLauncher.exe"
                    ).resolve()
                )
            )
        original_value = value.get("original_launch_options")
        return {
            **installation,
            "app_id": int(key),
            "managed_launch_executable": managed_value,
            "candidate_launch_executables": sorted(candidate_paths),
            "original_launch_options": (
                original_value
                if isinstance(original_value, str)
                else None
            ),
            "applied_launch_options": str(
                value.get("applied_launch_options") or ""
            ),
            "display_name": str(value.get("display_name") or ""),
            "target_type": (
                str(value.get("target_type")).casefold()
                if str(value.get("target_type") or "").casefold()
                in {"steam", "shortcut"}
                else None
            ),
            "launch_options_field": (
                str(value.get("launch_options_field")).casefold()
                if str(value.get("launch_options_field") or "").casefold()
                in {"app", "shortcut"}
                else None
            ),
            "shortcut_exe": str(value.get("shortcut_exe") or ""),
            "bound_at": str(value.get("bound_at") or ""),
            "active": True,
        }

    def list_binding_records(self) -> list[dict[str, Any]]:
        """Return recovery metadata without requiring trainer files to exist."""
        records: list[dict[str, Any]] = []
        for raw_app_id, raw_value in self._bindings().items():
            try:
                app_id = int(raw_app_id)
            except (TypeError, ValueError):
                continue
            if app_id <= 0 or not isinstance(raw_value, dict):
                continue

            installation_id = str(
                raw_value.get("installation_id") or raw_value.get("id") or ""
            )
            installation: dict[str, Any] | None = None
            if installation_id:
                try:
                    installation = self.get_installation(installation_id)
                except TrainerDeckError:
                    installation = None

            managed_value = str(
                raw_value.get("managed_launch_executable") or ""
            )
            legacy_missing_managed = not managed_value
            if legacy_missing_managed and installation is not None:
                folder = Path(installation["folder"])
                legacy_launcher = folder / "TrainerDeckBridgeLauncher.exe"
                managed_value = str(
                    legacy_launcher
                    if legacy_launcher.is_file()
                    else Path(installation["executable"])
                )

            raw_candidates = raw_value.get("candidate_launch_executables", [])
            if not isinstance(raw_candidates, list):
                raw_candidates = []
            candidates = {
                str(path)
                for path in raw_candidates
                if isinstance(path, str) and path
            }
            if managed_value:
                candidates.add(managed_value)
            if legacy_missing_managed and installation is not None:
                candidates.add(
                    str(Path(installation["executable"]).resolve())
                )
                candidates.add(
                    str(
                        (
                            Path(installation["folder"])
                            / "TrainerDeckBridgeLauncher.exe"
                        ).resolve()
                    )
                )
            original_value = raw_value.get("original_launch_options")

            records.append(
                {
                    "app_id": app_id,
                    "installation_id": installation_id,
                    "title": str(
                        (installation or {}).get("title")
                        or raw_value.get("display_name")
                        or f"Steam App {app_id}"
                    ),
                    "display_name": str(raw_value.get("display_name") or ""),
                    "target_type": (
                        str(raw_value.get("target_type")).casefold()
                        if str(raw_value.get("target_type") or "").casefold()
                        in {"steam", "shortcut"}
                        else None
                    ),
                    "launch_options_field": (
                        str(raw_value.get("launch_options_field")).casefold()
                        if str(
                            raw_value.get("launch_options_field") or ""
                        ).casefold()
                        in {"app", "shortcut"}
                        else None
                    ),
                    "shortcut_exe": str(raw_value.get("shortcut_exe") or ""),
                    "managed_launch_executable": managed_value,
                    "candidate_launch_executables": sorted(candidates),
                    "original_launch_options": (
                        original_value
                        if isinstance(original_value, str)
                        else None
                    ),
                    "applied_launch_options": str(
                        raw_value.get("applied_launch_options") or ""
                    ),
                    "bound_at": str(raw_value.get("bound_at") or ""),
                    "active": bool(raw_value.get("active", True)),
                    "launch_options_restored": bool(
                        raw_value.get("launch_options_restored", False)
                    ),
                    "unbound_at": str(raw_value.get("unbound_at") or ""),
                }
            )
        return sorted(records, key=lambda item: item["app_id"])

    def list_bindings(self) -> dict[int, dict[str, Any]]:
        resolved: dict[int, dict[str, Any]] = {}
        for raw_app_id in self._bindings():
            try:
                app_id = int(raw_app_id)
            except (TypeError, ValueError):
                continue
            if app_id <= 0:
                continue
            installation = self.get_binding(app_id)
            if installation is not None:
                resolved[app_id] = installation
        return resolved

    def unbind_trainer(
        self,
        app_id: int,
        launch_options_restored: bool = False,
    ) -> bool:
        try:
            key = str(int(app_id))
        except (TypeError, ValueError):
            return False
        bindings = self._bindings()
        value = bindings.get(key)
        removed = isinstance(value, dict) and bool(value.get("active", True))
        if isinstance(value, dict):
            value = dict(value)
            value["active"] = False
            value["launch_options_restored"] = bool(launch_options_restored)
            value["unbound_at"] = datetime.now(timezone.utc).isoformat()
            bindings[key] = value
            _atomic_write_json(self.bindings_path, bindings)
        return removed
