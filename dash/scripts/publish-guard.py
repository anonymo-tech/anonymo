#!/usr/bin/env python3
"""Check exact Git objects before release. Diagnostics never print matched content."""

import argparse
import base64
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

IDENTITY = b"Conclave Contributor <contributor@conclave.invalid>"
PRIVATE_PATH = re.compile(
    r"(^|/)(internal|node_modules|dist|build|coverage|__pycache__|\.git|\.data|\.cache|\.next|\.vinext|\.wrangler|\.vercel|\.claude|\.codex|\.openai|\.cursor|\.windsurf|\.aider|\.opencode)(/|$)"
    r"|(^|/)(AGENTS|CLAUDE|GEMINI|copilot-instructions)\.md$|(^|/)(\.env|\.dev\.vars)($|\.)"
    r"|^(INVARIANTS|OPERATIONS|SECURITY)\.md$|^web/server/(?:.*/)?FORMAT\.md$|^web/deploy/README\.md$"
    r"|\.(pem|key|p12|pfx|keystore|pdf|zip|7z|tar|gz|log|pyc|pyo)$"
    r"|(^|/)id_(rsa|ecdsa|ed25519)(\.|$)|^web/(docs|handoff|evidence|preview)/"
    r"|(^|/)(manifest[^/]*|.*(?:handoff|provenance|prompts?)[^/]*)$",
    re.IGNORECASE,
)
SECRET = re.compile(
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}"
    rb"|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"
    rb"|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}"
)
PERSONAL_PATH = re.compile(rb"/(?:Users|home)/[^/\s]+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]", re.I)
ATTRIBUTION = re.compile(rb"^\s*(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by)\s*:\s*(.*?)\s*$", re.I | re.M)
AUTHORING_FINGERPRINT = re.compile(
    rb"(?:generated|created|written|authored|implemented|built|made)\s+(?:with|by|using)\s+"
    rb"(?:\[)?(?:claude(?:\s+code)?|chatgpt|codex|cursor|windsurf|aider|github\s+copilot)\b"
    rb"|[\"'](?:generator|authoringTool)[\"']\s*:\s*[\"']"
    rb"(?:claude(?:[ _-]+code)?|chatgpt|codex|cursor|windsurf|aider|copilot)[\"']", re.I,
)


def git(*args, input=None):
    result = subprocess.run(["git", *args], input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"})
    if result.returncode:
        raise ValueError("Git operation failed: " + args[0])
    return result.stdout


def lines(path):
    if not path.is_file():
        return []
    return [line.strip() for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")]


class Guard:
    def __init__(self, public=False):
        self.errors = set()
        self.common = Path(os.fsdecode(git("rev-parse", "--git-common-dir").strip()))
        if (self.common / "info/grafts").exists() or os.environ.get("GIT_GRAFT_FILE"):
            self.fail("configuration", "Git grafts can conceal ancestry and are not permitted")
        self.denied = []
        for entry in lines(self.common / "info/publish-denylist"):
            substring = entry.startswith("substring:")
            term = entry[len("substring:"):] if substring else entry
            if not term.strip():
                self.fail("configuration", "private denylist contains an empty term")
                continue
            self.denied.append((term.encode().lower(), substring))
        self.denypaths = [re.compile(item, re.I) for item in lines(self.common / "info/publish-denypaths")]
        if not public and not self.denied:
            self.fail("configuration", "private denylist is missing or empty")
        self.seen_blobs = set()
        self.seen_trees = set()

    def fail(self, label, reason):
        self.errors.add((label, reason))

    def content(self, data, label, source_path=None):
        # Raw bytes plus UTF-16 variants cover binary containers and metadata.
        forms = [data]
        if b"\0" in data:
            forms += [data.decode(encoding, errors="ignore").encode("utf-8") for encoding in ("utf-16-le", "utf-16-be")]
        for form in forms:
            lowered = form.lower()
            for needle, substring in self.denied:
                if substring:
                    # Explicit private terms also match within identifiers, URLs,
                    # environment names and filenames. Binary packets are not text;
                    # printable metadata and decoded UTF-16 still receive this check.
                    try:
                        form.decode("utf-8")
                        text = b"\0" not in form
                    except UnicodeDecodeError:
                        text = False
                    fields = [lowered] if text else re.findall(rb"[\x20-\x7e\t\r\n]{8,}", lowered)
                    found = any(needle in field for field in fields)
                elif len(needle) >= 5:
                    found = needle in lowered
                else:
                    # Short handles collide with compressed packets and base64. In binary
                    # objects inspect printable fields; media metadata is rejected separately.
                    fields = [lowered] if b"\0" not in form else re.findall(rb"[\x20-\x7e\t\r\n]{8,}", lowered)
                    pattern = rb"(?<![a-z0-9_])" + re.escape(needle) + rb"(?![a-z0-9_])"
                    found = any(re.search(pattern, field) for field in fields)
                if found:
                    self.fail(label, "private denylist match")
            if SECRET.search(form):
                self.fail(label, "secret-like token")
            if PERSONAL_PATH.search(form):
                self.fail(label, "personal filesystem path")
            if AUTHORING_FINGERPRINT.search(form):
                self.fail(label, "authoring-tool attribution or fingerprint")

    def path(self, path):
        self.content(path.encode(), "path", source_path=path)
        if PRIVATE_PATH.search(path) or any(pattern.search(path) for pattern in self.denypaths):
            self.fail("path", "private or unsupported file path")
        if any(ord(char) < 32 for char in path):
            self.fail("path", "control characters in filename")

    def ident(self, value, label):
        match = re.fullmatch(rb"(.+) ([0-9]+) ([+-][0-9]{4})", value)
        if not match or match[1] != IDENTITY:
            self.fail(label, "identity must be the pinned project contributor")
        if not match or match[3] not in (b"+0000", b"-0000"):
            self.fail(label, "dates must use UTC")
        self.content(value, label)

    def message(self, data, label="commit message"):
        self.content(data, label)
        for match in ATTRIBUTION.finditer(data):
            if match[1] != IDENTITY:
                self.fail(label, "alternate attribution trailer")

    def media(self, data, path, label):
        suffix = Path(path).suffix.lower()
        try:
            if suffix == ".png":
                if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError()
                offset = 8
                while offset + 12 <= len(data):
                    size = struct.unpack_from(">I", data, offset)[0]
                    kind = data[offset + 4:offset + 8]
                    if kind in (b"eXIf", b"tEXt", b"zTXt", b"iTXt", b"tIME"):
                        self.fail(label, "PNG metadata")
                    if offset + 12 + size > len(data):
                        raise ValueError()
                    offset += 12 + size
                    if kind == b"IEND":
                        if offset != len(data):
                            self.fail(label, "PNG trailing data")
                        break
            elif suffix in (".jpg", ".jpeg"):
                if not data.startswith(b"\xff\xd8"):
                    raise ValueError()
                offset = 2
                while offset + 4 <= len(data):
                    if data[offset] != 255:
                        raise ValueError()
                    kind = data[offset + 1]
                    if kind in (0xDA, 0xD9):
                        break
                    size = struct.unpack_from(">H", data, offset + 2)[0]
                    if kind in (0xE1, 0xED, 0xFE):
                        self.fail(label, "JPEG metadata")
                    if size < 2 or offset + 2 + size > len(data):
                        raise ValueError()
                    offset += 2 + size
            elif suffix == ".webp":
                if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
                    raise ValueError()
                offset = 12
                while offset + 8 <= len(data):
                    kind = data[offset:offset + 4]
                    size = struct.unpack_from("<I", data, offset + 4)[0]
                    if kind in (b"EXIF", b"XMP "):
                        self.fail(label, "WebP metadata")
                    if offset + 8 + size > len(data):
                        raise ValueError()
                    offset += 8 + size + size % 2
            elif suffix in (".mp4", ".mov", ".m4v"):
                self.mp4(data, 0, len(data), label)
            elif suffix == ".webm":
                if not data.startswith(b"\x1aE\xdf\xa3"):
                    raise ValueError()
                self.webm(data, 0, len(data), label)
            elif suffix == ".svg":
                if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                    raise ValueError()
                root = ET.fromstring(data)
                for element in root.iter():
                    if element.tag.rsplit("}", 1)[-1] == "metadata":
                        self.fail(label, "SVG metadata")
                    for value in element.attrib.values():
                        match = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)", value)
                        if match:
                            embedded = base64.b64decode(re.sub(r"\s", "", match[2]), validate=True)
                            self.content(embedded, label + " embedded image")
                            self.media(embedded, "embedded." + match[1], label + " embedded image")
        except (ValueError, struct.error, IndexError, ET.ParseError):
            self.fail(label, "malformed media container")

    def mp4(self, data, start, end, label):
        offset = start
        while offset < end:
            if offset + 8 > end:
                raise ValueError()
            size, kind = struct.unpack_from(">I4s", data, offset)
            header = 8
            if size == 1:
                size = struct.unpack_from(">Q", data, offset + 8)[0]
                header = 16
            elif size == 0:
                size = end - offset
            if size < header or offset + size > end:
                raise ValueError()
            content = offset + header
            if kind in (b"udta", b"meta", b"uuid"):
                self.fail(label, "video metadata atom")
            if kind in (b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"mvex"):
                self.mp4(data, content, offset + size, label)
            if kind in (b"mvhd", b"tkhd", b"mdhd"):
                width = 8 if data[content] == 1 else 4
                if any(data[content + 4:content + 4 + width * 2]):
                    self.fail(label, "video creation or modification date")
            offset += size

    def webm(self, data, start, end, label):
        def vint(offset, identifier=False):
            first = data[offset]
            width = next((size for size in range(1, 9) if first & (1 << (8 - size))), 0)
            if not width or offset + width > end:
                raise ValueError()
            value = int.from_bytes(data[offset:offset + width], "big")
            if not identifier:
                value &= (1 << (7 * width)) - 1
                if value == (1 << (7 * width)) - 1:
                    return None, width
            return value, width

        offset = start
        while offset < end:
            kind, width = vint(offset, True)
            size, length = vint(offset + width)
            content = offset + width + length
            boundary = end if size is None else content + size
            if boundary > end:
                raise ValueError()
            if kind in (0x4461, 0x7BA9, 0x1254C367, 0x1941A469):
                self.fail(label, "WebM date, title, tags or attachments")
            if kind in (0x4D80, 0x5741) and data[content:boundary].rstrip(b"\0") != b"WebM":
                self.fail(label, "WebM producer metadata is not normalized")
            if kind in (0x1A45DFA3, 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0, 0xE1):
                self.webm(data, content, boundary, label)
            offset = boundary

    def entries(self, entries):
        for mode, kind, oid, path in entries:
            self.path(path)
            if mode not in ("100644", "100755") or kind != "blob":
                self.fail("tree", "symlinks, submodules and unsupported modes cannot ship")
                continue
            key = (oid, Path(path).suffix.lower())
            if key not in self.seen_blobs:
                self.seen_blobs.add(key)
                data = git("cat-file", "blob", oid)
                label = "blob " + oid[:12]
                self.content(data, label, source_path=path)
                self.media(data, path, label)

    def tree(self, tree):
        if tree in self.seen_trees:
            return
        self.seen_trees.add(tree)
        entries = []
        for record in git("ls-tree", "-rz", "--full-tree", tree).split(b"\0"):
            if record:
                header, path = record.split(b"\t", 1)
                mode, kind, oid = header.decode().split()
                entries.append((mode, kind, oid, os.fsdecode(path)))
        self.entries(entries)

    def staged(self):
        for who in ("AUTHOR", "COMMITTER"):
            self.ident(git("var", "GIT_" + who + "_IDENT").strip(), who.lower())
        entries = []
        for record in git("ls-files", "--stage", "-z").split(b"\0"):
            if record:
                header, path = record.split(b"\t", 1)
                mode, oid, stage = header.decode().split()
                if stage != "0":
                    self.fail("index", "unresolved merge")
                entries.append((mode, "blob", oid, os.fsdecode(path)))
        self.entries(entries)

    def history(self, refs):
        if git("rev-parse", "--is-shallow-repository").strip() != b"false":
            self.fail("history", "complete ancestry is required; shallow history cannot be published")
            return
        for ref in refs:
            if ref.startswith("-"):
                raise ValueError("history accepts explicit commit references, not revision options")
            if git("cat-file", "-t", ref).strip() != b"commit":
                raise ValueError("only commit references may be published")
        commits = git("rev-list", *refs, "--").decode().splitlines()
        if not commits:
            raise ValueError("no commits to scan")
        for oid in commits:
            raw = git("cat-file", "commit", oid)
            self.content(raw, "commit " + oid[:12])
            header, message = raw.split(b"\n\n", 1)
            tree = None
            identities = set()
            for line in header.splitlines():
                field, _, value = line.partition(b" ")
                if field in (b"author", b"committer"):
                    self.ident(value, "commit " + oid[:12] + " " + field.decode())
                    identities.add(field)
                elif field == b"tree":
                    tree = value.decode()
                elif field != b"parent":
                    self.fail("commit " + oid[:12], "unsupported commit header or signature")
            if identities != {b"author", b"committer"} or not tree:
                self.fail("commit " + oid[:12], "missing commit metadata")
            self.message(message, "commit " + oid[:12] + " message")
            if tree:
                self.tree(tree)

    def finish(self):
        for label, reason in sorted(self.errors):
            print("publish-guard: " + label + ": " + reason, file=sys.stderr)
        if self.errors:
            print("publish-guard: blocked.", file=sys.stderr)
            return 1
        print("publish-guard: passed (" + str(len(self.seen_blobs)) + " unique file objects checked).")
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-ci", action="store_true", help="run public checks without private denylist; mirror must run full checks")
    parser.add_argument("mode", choices=("staged", "message", "history"))
    parser.add_argument("values", nargs="*")
    args = parser.parse_args()
    try:
        guard = Guard(public=args.public_ci)
        if args.mode == "staged":
            guard.staged()
        elif args.mode == "message":
            if len(args.values) != 1:
                raise ValueError("message requires one file")
            guard.message(Path(args.values[0]).read_bytes())
        else:
            guard.history(args.values or ["HEAD"])
        return guard.finish()
    except (ValueError, OSError, UnicodeError) as error:
        print("publish-guard: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
