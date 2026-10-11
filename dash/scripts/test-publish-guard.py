#!/usr/bin/env python3
"""Regression tests for release identity, history and binary inspection."""

import os
import base64
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

GUARD = Path(__file__).with_name("publish-guard.py").resolve()
HOOK = GUARD.parent.parent / ".githooks/pre-push"
NAME = "Conclave Contributor"
EMAIL = "contributor@conclave.invalid"


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = {**os.environ, "TZ": "UTC", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_AUTHOR_NAME": NAME, "GIT_AUTHOR_EMAIL": EMAIL, "GIT_COMMITTER_NAME": NAME,
                    "GIT_COMMITTER_EMAIL": EMAIL, "GIT_AUTHOR_DATE": "2026-10-01T12:00:00+0000",
                    "GIT_COMMITTER_DATE": "2026-10-01T12:00:00+0000"}
        self.run_cmd("git", "init", "-q", "-b", "main")
        self.write(".git/info/publish-denylist", "private-fixture-marker\n")
        self.write("safe.txt", "safe fixture\n")
        self.run_cmd("git", "add", ".")

    def tearDown(self):
        self.temp.cleanup()

    def run_cmd(self, *args, env=None, input=None):
        result = subprocess.run(args, cwd=self.root, env={**self.env, **(env or {})}, input=input,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return result.stdout

    def write(self, path, data):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data if isinstance(data, bytes) else data.encode())

    def guard(self, *args, blocked=False, env=None):
        result = subprocess.run(["python3", str(GUARD), *args], cwd=self.root,
                                env={**self.env, **(env or {})}, capture_output=True)
        self.assertEqual(result.returncode != 0, blocked, result.stderr.decode())
        return result

    def commit(self, message="✨ Add interface fixture", env=None):
        self.run_cmd("git", "add", ".")
        self.run_cmd("git", "commit", "-qm", message, env=env)

    def test_staged_and_pinned_identity(self):
        self.guard("staged")
        for key, value in [("GIT_AUTHOR_NAME", "Alternate Contributor"), ("GIT_COMMITTER_NAME", "Alternate Contributor"),
                           ("GIT_AUTHOR_EMAIL", "alternate@example.invalid"), ("GIT_COMMITTER_EMAIL", "alternate@example.invalid"),
                           ("GIT_AUTHOR_DATE", "2026-10-01T12:00:00-0500")]:
            self.guard("staged", blocked=True, env={key: value})

    def test_missing_local_denylist_is_closed(self):
        (self.root / ".git/info/publish-denylist").unlink()
        self.guard("staged", blocked=True)
        self.guard("--public-ci", "staged")

    def test_full_index_not_just_added_lines(self):
        self.write("safe.txt", "private-fixture-marker")
        self.commit()
        self.write("other.txt", "safe")
        self.run_cmd("git", "add", ".")
        self.guard("staged", blocked=True)

    def test_deleted_private_content_in_history(self):
        self.write("safe.txt", "private-fixture-marker")
        self.commit()
        self.write("safe.txt", "clean")
        self.commit()
        self.guard("history", "HEAD", blocked=True)

    def test_binary_utf16_denylist_without_logging_match(self):
        self.write("sample.bin", "private-fixture-marker".encode("utf-16-le"))
        self.run_cmd("git", "add", ".")
        result = self.guard("staged", blocked=True)
        self.assertNotIn(b"private-fixture-marker", result.stderr)

    def test_secret_and_personal_path(self):
        for data in [b"ghp_" + b"a" * 36, ("/" + "Users" + "/fixture/project").encode()]:
            self.write("sample.bin", data)
            self.run_cmd("git", "add", ".")
            self.guard("staged", blocked=True)

    def test_short_handle_in_text_and_binary_metadata(self):
        self.write(".git/info/publish-denylist", "xyz\n")
        for data in [b"contact xyz here", b"\0creator=xyz\0"]:
            self.write("sample.bin", data)
            self.run_cmd("git", "add", ".")
            self.guard("staged", blocked=True)
        self.write("sample.bin", b"\0\x01xyz\x02\0")
        self.run_cmd("git", "add", ".")
        self.guard("staged")

    def test_forced_private_path_and_symlink(self):
        self.write("internal/private.txt", "safe")
        self.run_cmd("git", "add", ".")
        self.guard("staged", blocked=True)
        self.run_cmd("git", "rm", "--cached", "internal/private.txt")
        (self.root / "link").symlink_to("safe.txt")
        self.run_cmd("git", "add", "link")
        self.guard("staged", blocked=True)

    def test_forced_build_outputs_and_tool_state(self):
        for path in ("dist/private.json", ".dev.vars", ".dev.vars.production", ".vercel/project.json",
                     "config.pyo", ".cache/local.json"):
            self.write(path, "private fixture")
            self.run_cmd("git", "add", path)
            self.guard("staged", blocked=True)
            self.run_cmd("git", "rm", "--cached", path)

    def test_attribution(self):
        self.write("message", "✨ Improve interface\n\nCo-authored-by: Alternate Contributor <alternate@example.invalid>\n")
        self.guard("message", "message", blocked=True)

    def test_private_terms_have_no_source_path_exceptions(self):
        for path in ("server/gateway/index.ts", "scripts/check-gateway.mjs", "deploy/deploy.mjs",
                     "deploy/environments.json", ".github/workflows/release-checks.yml", "README.md",
                     "scripts/publish-guard.py", "scripts/test-publish-guard.py", "public/licenses/example.txt"):
            self.write(path, "private-fixture-marker")
            self.run_cmd("git", "add", path)
            self.guard("staged", blocked=True)
            self.run_cmd("git", "rm", "--cached", path)

    def test_substring_terms_cover_embedded_identifiers_paths_and_messages(self):
        self.write(".git/info/publish-denylist", "substring:xyz\nprivate-fixture-marker\n")
        for data in ("XYZ", "PREFIX_XYZ_KEY", "ExampleXyzClient", "https://api.xyz.invalid/path"):
            self.write("sample.ts", data)
            self.run_cmd("git", "add", "sample.ts")
            result = self.guard("staged", blocked=True)
            self.assertNotIn(b"xyz", result.stderr.lower())
        self.write("sample.ts", "safe")
        self.run_cmd("git", "add", "sample.ts")
        self.write("xyzClient.ts", "safe")
        self.run_cmd("git", "add", "xyzClient.ts")
        self.guard("staged", blocked=True)
        self.run_cmd("git", "rm", "--cached", "xyzClient.ts")
        self.write("message", "Change prefixXyzSuffix")
        self.guard("message", "message", blocked=True)
        self.write("sample.ts", "private-fixture-marker")
        self.run_cmd("git", "add", "sample.ts")
        self.guard("staged", blocked=True)

    def test_substring_terms_cover_metadata_but_not_compressed_packets(self):
        self.write(".git/info/publish-denylist", "substring:xyz\n")
        for data in (b"\0creator=prefixXYZsuffix\0", "prefixXyzSuffix".encode("utf-16-le"),
                     "prefixXyzSuffix".encode("utf-16-be")):
            self.write("sample.bin", data)
            self.run_cmd("git", "add", "sample.bin")
            self.guard("staged", blocked=True)
        self.write("sample.bin", b"\0\x01xyz\x02\0")
        self.run_cmd("git", "add", "sample.bin")
        self.guard("staged")

    def test_substring_terms_cannot_be_empty_or_hidden_in_old_trees(self):
        self.write(".git/info/publish-denylist", "substring:\nprivate-fixture-marker\n")
        self.guard("staged", blocked=True)
        self.guard("--public-ci", "staged", blocked=True)
        self.write(".git/info/publish-denylist", "substring:xyz\n")
        self.write("sample.ts", "ExampleXyzClient")
        self.commit()
        self.write("sample.ts", "clean")
        self.commit()
        self.guard("staged")
        self.guard("history", "HEAD", blocked=True)

    def test_authoring_fingerprints_have_no_product_exception(self):
        for tool in ("Claude", "ChatGPT", "Codex", "Cursor", "Windsurf", "Aider", "GitHub Copilot"):
            self.write("server/product.ts", "Generated " + "with " + tool + "\n")
            self.run_cmd("git", "add", "server/product.ts")
            self.guard("staged", blocked=True)
        for suffix in ("code", "Code"):
            self.write("server/product.ts", '"generator": "Claude ' + suffix + '"')
            self.run_cmd("git", "add", "server/product.ts")
            self.guard("staged", blocked=True)
        self.write("server/product.ts", "Claude is an available model.\n")
        self.run_cmd("git", "add", "server/product.ts")
        self.write("app/docs/page.tsx", "Claude " + "Code is a supported integration; its name belongs to its owner.\n")
        self.run_cmd("git", "add", "app/docs/page.tsx")
        self.guard("staged")

    def test_build_documents_and_tool_files_stay_private(self):
        for path in ("INVARIANTS.md", "OPERATIONS.md", "SECURITY.md", "server/receipts/FORMAT.md",
                     "deploy/README.md", ".env.example", ".cursor/rules/fixture.md",
                     "GEMINI.md", ".github/copilot-instructions.md"):
            self.write(path, "safe fixture")
            self.run_cmd("git", "add", path)
            self.guard("staged", blocked=True)
            self.run_cmd("git", "rm", "--cached", path)
        self.write("app/docs/page.tsx", "export const productHelp = true;\n")
        self.write("public/licenses/example-LICENSE.txt", "Required third-party attribution.\n")
        self.run_cmd("git", "add", "app/docs/page.tsx", "public/licenses/example-LICENSE.txt")
        self.guard("staged")

    def test_both_layouts_block_private_handoffs_and_preserve_product_docs(self):
        # Earlier published commits retain their web/ prefix. The same exclusions
        # apply to those trees and to the current root layout during full scans.
        for prefix in ("", "web/"):
            for suffix in ("server/FORMAT.md", "server/receipts/FORMAT.md", "deploy/README.md",
                           "docs/notes.md", "handoff/notes.md", "evidence/notes.md", "preview/notes.md",
                           ".env.example", "dist/private.json", ".dev.vars.production"):
                path = prefix + suffix
                self.write(path, "safe fixture")
                self.run_cmd("git", "add", path)
                self.guard("staged", blocked=True)
                self.run_cmd("git", "rm", "--cached", path)
            for suffix in ("app/docs/page.tsx", "public/licenses/example-LICENSE.txt", "server/service.ts"):
                path = prefix + suffix
                self.write(path, "Public product content.")
                self.run_cmd("git", "add", path)
            self.guard("staged")

    def test_root_move_keeps_historical_content_under_full_scan(self):
        self.write("web/server/service.ts", "Public service fixture.")
        self.commit()
        (self.root / "server").mkdir()
        self.run_cmd("git", "mv", "web/server/service.ts", "server/service.ts")
        self.commit()
        self.guard("history", "HEAD")
        self.write("server/service.ts", "private-fixture-marker")
        self.commit()
        self.write("server/service.ts", "Public service fixture.")
        self.commit()
        self.guard("staged")
        self.guard("history", "HEAD", blocked=True)

    def test_private_legacy_path_policy_still_blocks_flattened_paths(self):
        self.write(".git/info/publish-denypaths", r"^web/server/local-state\.json$" + "\n")
        for path in ("server/local-state.json", "web/server/local-state.json"):
            self.write(path, "safe fixture")
            self.run_cmd("git", "add", path)
            self.guard("staged", blocked=True)
            self.run_cmd("git", "rm", "--cached", path)
        self.write("server/service.ts", "Public service fixture.")
        self.run_cmd("git", "add", "server/service.ts")
        self.guard("staged")

    def test_merge_parent_and_merge_only_content(self):
        self.commit()
        self.run_cmd("git", "switch", "-qc", "feature")
        self.write("feature.txt", "safe feature")
        self.commit(env={"GIT_AUTHOR_NAME": "Alternate Contributor"})
        self.run_cmd("git", "switch", "-q", "main")
        self.write("main.txt", "safe main")
        self.commit()
        self.run_cmd("git", "merge", "--no-commit", "--no-ff", "feature")
        self.write("merged.txt", "private-fixture-marker")
        self.commit()
        self.guard("history", "HEAD", blocked=True)

    def test_allows_safe_history_rejects_tag_object(self):
        self.commit()
        self.guard("history", "HEAD")
        self.run_cmd("git", "tag", "-a", "sample", "-m", "sample")
        self.guard("history", "sample", blocked=True)

    def test_replacement_refs_cannot_hide_identity(self):
        self.commit(env={"GIT_AUTHOR_NAME": "Alternate Contributor"})
        bad = self.run_cmd("git", "rev-parse", "HEAD").decode().strip()
        tree = self.run_cmd("git", "rev-parse", "HEAD^{tree}").decode().strip()
        replacement = self.run_cmd("git", "commit-tree", tree, input=b"Safe replacement\n").decode().strip()
        self.run_cmd("git", "replace", bad, replacement)
        self.guard("history", "HEAD", blocked=True)

    def test_grafts_and_shallow_history_are_closed(self):
        self.commit()
        head = self.run_cmd("git", "rev-parse", "HEAD")
        self.guard("history", "HEAD")
        self.write(".git/info/grafts", head)
        self.guard("history", "HEAD", blocked=True)
        (self.root / ".git/info/grafts").unlink()
        self.write(".git/shallow", head)
        self.guard("history", "HEAD", blocked=True)

    def test_png_and_mp4_metadata(self):
        chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + b"\0" * 4
        self.write("image.png", b"\x89PNG\r\n\x1a\n" + chunk(b"tEXt", b"Creator\0fixture") + chunk(b"IEND", b""))
        self.run_cmd("git", "add", ".")
        self.guard("staged", blocked=True)
        self.run_cmd("git", "rm", "--cached", "image.png")
        self.write("film.mp4", struct.pack(">I4s", 8, b"udta"))
        self.run_cmd("git", "add", "film.mp4")
        self.guard("staged", blocked=True)

    def test_svg_embedded_metadata(self):
        chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + b"\0" * 4
        image = b"\x89PNG\r\n\x1a\n" + chunk(b"tEXt", b"Creator\0fixture") + chunk(b"IEND", b"")
        self.write("image.svg", '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,'
                   + base64.b64encode(image).decode() + '"/></svg>')
        self.run_cmd("git", "add", ".")
        self.guard("staged", blocked=True)

    def test_push_lock_and_remote_check(self):
        self.commit()
        payload = ("refs/heads/main " + self.run_cmd("git", "rev-parse", "HEAD").decode().strip()
                   + " refs/heads/main " + "0" * 40 + "\n").encode()
        result = subprocess.run(["sh", str(HOOK), "origin", "https://github.com/example/project.git"], cwd=self.root,
                                env=self.env, input=payload, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.run_cmd("git", "config", "--local", "conclave.pushAuthorized", "true")
        result = subprocess.run(["sh", str(HOOK), "origin", "https://github.com/example/project.git"], cwd=self.root,
                                env=self.env, input=payload, capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
