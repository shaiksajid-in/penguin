"""PENGUIN settings server: serves the settings page and its small JSON API on 127.0.0.1.

Started by the PENGUIN plugin with:  python3 -I settings_server.py <token> <settings.json> <project folder>
The project folder is the Claude session's folder: per-project options (like .gitignore) act on its git repo.
Prints "PORT <n>" once listening, then one line per change the plugin must act on:
  SETTINGS <json>      the settings file changed (tool enabled/disabled)
  INSTALLED <tool-id>  an install or uninstall finished (the plugin re-checks the tool)
  OUTPUT_DELETED <id>  the tool's output folder was deleted (the plugin re-reads the graph stats)
The plugin owns its lifetime: it is killed when the plugin stops it, reloads or the session ends.
"""

# macOS ships Python 3.9: this keeps the `X | None` type hints from being evaluated at import.
from __future__ import annotations

import hmac
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = sys.argv[1]
SETTINGS = Path(sys.argv[2])
PROJECT = Path(sys.argv[3]) if len(sys.argv) > 3 else None
PAGE = Path(__file__).with_name("index.html")
# The one logo file: the page shows it, and the toolbar draws the same file on desktop.
LOGO = Path(__file__).parent.parent / "assets" / "logo.svg"

# Every tool PENGUIN knows. `check` finds it on PATH; `install` and `uninstall` are shell commands;
# `generated` is the folder the tool writes into a project, offered for .gitignore and for deletion.
TOOLS = {
    "graphify": {
        "name": "Graphify",
        "description": "Turns this folder's code into a knowledge graph Claude can query with fewer tokens.",
        "repo": "https://github.com/Graphify-Labs/graphify",
        "check": "graphify",
        "install": (
            'if command -v uv >/dev/null; then uv tool install "graphifyy[watch,mcp]"; '
            'elif command -v pipx >/dev/null; then pipx install "graphifyy[watch,mcp]"; '
            'else echo "needs uv or pipx (https://docs.astral.sh/uv/)" >&2; exit 1; fi'
        ),
        # `graphify uninstall` first: it removes graphify's skill and git hooks while the command still exists.
        "uninstall": (
            "graphify uninstall >/dev/null 2>&1; "
            "if command -v uv >/dev/null && uv tool list 2>/dev/null | grep -q '^graphifyy '; then uv tool uninstall graphifyy; "
            "elif command -v pipx >/dev/null && pipx list --short 2>/dev/null | grep -q '^graphifyy '; then pipx uninstall graphifyy; "
            'else echo "graphify was not installed with uv or pipx; remove it the way you installed it" >&2; exit 1; fi'
        ),
        "generated": "graphify-out",
        # The MCP server that lets Claude query the graph: `command <project>/<graph>`, registered per project.
        "mcp": {"name": "graphify", "command": "graphify-mcp", "graph": "graphify-out/graph.json"},
    },
    # Claude Code plugins: `plugin` is the installed id, checked in Claude's plugin registry. They have nothing on
    # the bar, so the page shows no "Show on bar" switch for them.
    "superpowers": {
        "name": "Superpowers",
        "description": "A development workflow for Claude: brainstorm, plan, test first, review, then merge.",
        "repo": "https://github.com/obra/superpowers",
        "plugin": "superpowers@claude-plugins-official",
        # Adds the official marketplace first when it is missing (a fresh or reset ~/.claude has only the built-in one).
        "install": (
            "{ claude plugin marketplace list | grep -q 'claude-plugins-official' || "
            "claude plugin marketplace add anthropics/claude-plugins-official; } && "
            "claude plugin install superpowers@claude-plugins-official --scope user"
        ),
        "uninstall": "claude plugin uninstall superpowers@claude-plugins-official --scope user",
        "update": "claude plugin update superpowers@claude-plugins-official --scope user",
    },
    "ponytail": {
        "name": "Ponytail",
        "description": "Makes Claude write the least code that fully works: reuse first, no unrequested extras.",
        "repo": "https://github.com/DietrichGebert/ponytail",
        "plugin": "ponytail@ponytail",
        # Ponytail's own band stays hidden: "off" in its flag file is what `/ponytail band off` writes, and
        # `/ponytail band` brings it back.
        "install": (
            "{ claude plugin marketplace list | grep -q 'DietrichGebert/ponytail' || "
            "claude plugin marketplace add DietrichGebert/ponytail; } && "
            "claude plugin install ponytail@ponytail --scope user && "
            'printf off > "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.ponytail-band"'
        ),
        "uninstall": "claude plugin uninstall ponytail@ponytail --scope user",
        "update": "claude plugin update ponytail@ponytail --scope user",
        # Ponytail's figures can show on PENGUIN's bar, each one switchable (keys match detailCols in hooks/ponytail.ts).
        "bar": True,
        "stats": {
            "cost": "Session cost",
            "last": "Last turn cost",
            "turns": "Turns",
            "tokens": "Tokens",
            "time": "Agent time",
            "reuse": "Reuse %",
            "callers": "Callers open",
            "tests": "Tests",
        },
    },
    # A roster of subagent .md files the repo's own script copies into ~/.claude/agents. `file` marks it installed.
    # No uninstall: the script has none, and PENGUIN won't bulk-delete files from the user's agents folder.
    "agency": {
        "name": "Agency Agents",
        "description": "Hundreds of specialist subagents. Pick one on the bar and hand it a task.",
        "repo": "https://github.com/msitarzewski/agency-agents",
        "file": "agents/agents-orchestrator.md",
        # Where the bar copies a picked agent in the session's folder; the page offers to keep those copies out of git.
        "copies": ".claude/agents",
        "install": (
            'd="$(mktemp -d)" && git clone -q --depth 1 https://github.com/msitarzewski/agency-agents "$d" && '
            '"$d/scripts/install.sh" --tool claude-code --no-interactive; r=$?; rm -rf "$d"; exit $r'
        ),
    },
}

CLAUDE_CONFIG = Path.home() / ".claude.json"
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def is_installed(t: dict) -> bool:
    if "file" in t:
        return (CLAUDE_DIR / t["file"]).is_file()
    if "plugin" not in t:
        return shutil.which(t["check"]) is not None
    try:
        plugins = json.loads((CLAUDE_DIR / "plugins" / "installed_plugins.json").read_text()).get("plugins", {})
    except (OSError, ValueError):
        return False
    return bool(plugins.get(t["plugin"]))


def mcp_state(spec: dict) -> dict:
    """Whether Claude sessions in the project have the MCP server, and where it is configured.

    `local` is the user's private per-project entry in ~/.claude.json (what `claude mcp add` writes by default,
    and the only kind PENGUIN adds or removes); `project` is a shared .mcp.json the user wrote.
    """
    graph = PROJECT / spec["graph"]
    try:
        local = json.loads(CLAUDE_CONFIG.read_text()).get("projects", {}).get(str(PROJECT), {}).get("mcpServers", {})
    except (OSError, ValueError):
        local = {}
    try:
        shared = json.loads((PROJECT / ".mcp.json").read_text()).get("mcpServers", {})
    except (OSError, ValueError):
        shared = {}
    scope = "local" if spec["name"] in local else "project" if spec["name"] in shared else None
    return {"connected": scope is not None, "scope": scope, "graph": graph.is_file(), "project": PROJECT.name}


def claude_mcp(*args: str) -> subprocess.CompletedProcess:
    # Run in the project folder: `claude mcp` keys a local-scope server by the folder it runs in.
    return subprocess.run(["claude", "mcp", *args], cwd=PROJECT, capture_output=True, text=True, timeout=60)


def connect(tid: str) -> str | None:
    """Registers the tool's MCP server for the project unless it already is. Returns an error, or None."""
    spec = TOOLS[tid].get("mcp")
    if PROJECT is None or spec is None:
        return "no project folder"
    current = mcp_state(spec)
    if current["connected"]:
        return None
    if not current["graph"]:
        return "build a graph first (↻ on the bar)"
    command = shutil.which(spec["command"])
    if command is None:
        return f"{spec['command']} not found; is {TOOLS[tid]['name']} installed?"
    try:
        r = claude_mcp("add", spec["name"], "--scope", "local", "--", command, str(PROJECT / spec["graph"]))
    except FileNotFoundError:
        return "the claude command isn't on PATH"
    except subprocess.TimeoutExpired:
        return "claude mcp timed out"
    if r.returncode != 0:
        return ((r.stderr.strip() or r.stdout.strip()).splitlines() or ["connect failed"])[-1]
    return None

lock = threading.Lock()
installing: set[str] = set()


def emit(line: str) -> None:
    print(line, flush=True)


def load_settings() -> dict:
    try:
        data = json.loads(SETTINGS.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(SETTINGS)  # atomic, so the plugin never reads half a file


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(PROJECT), *args], capture_output=True, text=True, timeout=10)


def git_root() -> Path | None:
    """The git repo the session's folder is in, or None (no folder, not a repo, or no git)."""
    if PROJECT is None:
        return None
    try:
        r = git("rev-parse", "--show-toplevel")
    except (OSError, subprocess.TimeoutExpired):
        return None
    return Path(r.stdout.strip()) if r.returncode == 0 else None


def is_ignored(folder: str) -> bool:
    # git decides, so a rule in any .gitignore, .git/info/exclude or the global excludes file counts.
    # --no-index: answer for the folder even before the tool has created it.
    try:
        return git("check-ignore", "-q", "--no-index", f"{folder}/").returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


MARK = "(added by PENGUIN)"
# Blocks written before the name went all caps; still recognised, so they can be removed from the page.
OLD_MARKS = ("(added by Penguin)",)


def penguin_line(lines: list[str], folder: str) -> int | None:
    """Index of the comment line of the block PENGUIN added for `folder`, or None (a rule the user wrote isn't ours)."""
    for i in range(len(lines) - 1):
        if lines[i].startswith("#") and lines[i].endswith((MARK, *OLD_MARKS)) and lines[i + 1].strip() == f"{folder}/":
            return i
    return None


def added_by_penguin(root: Path, folder: str) -> bool:
    path = root / ".gitignore"
    return path.exists() and penguin_line(path.read_text().split("\n"), folder) is not None


def remove_from_gitignore(root: Path, folder: str) -> None:
    """Removes only the block PENGUIN added; the user's own rules are never touched."""
    path = root / ".gitignore"
    if not path.exists():
        return
    lines = path.read_text().split("\n")
    i = penguin_line(lines, folder)
    if i is None:
        return
    start = i - 1 if i > 0 and lines[i - 1] == "" else i  # the blank line we put before the block
    del lines[start : i + 2]
    text = "\n".join(lines).rstrip("\n")
    if text.strip():
        path.write_text(text + "\n")
    else:
        path.unlink()  # nothing left but our block: PENGUIN created this file, so take it away again


def add_to_gitignore(root: Path, folder: str, tool: str) -> None:
    """Appends `folder/` to the repo's top .gitignore, keeping everything already there."""
    path = root / ".gitignore"
    text = path.read_text() if path.exists() else ""
    if text and not text.endswith("\n"):
        text += "\n"
    if text:
        text += "\n"  # a blank line before our block
    # A bare "name/" pattern matches the folder at any depth, wherever in the repo the tool runs.
    path.write_text(f"{text}# {tool} output {MARK}\n{folder}/\n")


def agent_copies(t: dict) -> list[Path]:
    """The agent files the bar copied into the session's folder: those whose name matches one in ~/.claude/agents.

    shortcut: matched by file name, so a project agent that happens to share a name with a global one counts too;
    keep a list of copies if that ever bites.
    """
    if PROJECT is None or "copies" not in t:
        return []
    folder = PROJECT / t["copies"]
    if folder.resolve() == (CLAUDE_DIR / "agents").resolve():  # the session runs in home: these are the originals
        return []
    return sorted(f for f in folder.glob("*.md") if (CLAUDE_DIR / "agents" / f.name).is_file())


COPIES_MARK = f"# Agency Agents copies {MARK}"
COPIES_MARKS = (COPIES_MARK, *(f"# Agency Agents copies {m}" for m in OLD_MARKS))


def copies_block(lines: list[str]) -> tuple[int, int] | None:
    """Start and end (exclusive) of PENGUIN's copies block: the mark line and the file lines under it."""
    i = next((n for n, line in enumerate(lines) if line in COPIES_MARKS), None)
    if i is None:
        return None
    j = i + 1
    while j < len(lines) and lines[j].strip() and not lines[j].startswith("#"):
        j += 1
    return i, j


def set_copies_ignored(root: Path, files: list[Path] | None) -> None:
    """Rewrites PENGUIN's copies block in the repo's top .gitignore to list `files`, or removes it (None).

    Only that block changes; every rule the user wrote stays as it is.
    """
    path = root / ".gitignore"
    lines = path.read_text().split("\n") if path.exists() else []
    block = copies_block(lines)
    if block:
        i, j = block
        if i > 0 and lines[i - 1] == "":
            i -= 1  # the blank line PENGUIN put before the block
        del lines[i:j]
    text = "\n".join(lines).rstrip("\n")
    if files:
        rel = [os.path.relpath(f.resolve(), root.resolve()) for f in files]
        text = (text + "\n\n" if text else "") + "\n".join([COPIES_MARK, *("/" + r for r in rel)])
    if text.strip():
        path.write_text(text + "\n")
    elif path.exists():
        path.unlink()  # nothing left but PENGUIN's block: PENGUIN created this file


def ignored_count(files: list[Path]) -> int:
    if not files:
        return 0
    try:
        r = git("check-ignore", "--no-index", *map(str, files))
    except (OSError, subprocess.TimeoutExpired):
        return 0
    return len([line for line in r.stdout.splitlines() if line.strip()])


def copies_state(t: dict, root: Path | None) -> dict | None:
    files = agent_copies(t)
    if not files:
        return None
    path = None if root is None else root / ".gitignore"
    ours = bool(path and path.exists() and copies_block(path.read_text().split("\n")))
    return {
        "folder": t["copies"],
        "count": len(files),
        "ignored": ignored_count(files) if root else 0,
        "ours": ours,
        "repo": root.name if root else None,
        "project": PROJECT.name,
    }


# True while the marketplaces are being refreshed (at server start), so the page knows to look again for updates.
checking = False


def refresh_marketplaces() -> None:
    """Fetches the latest catalog of every marketplace a listed plugin comes from (network; runs in a thread)."""
    global checking
    checking = True
    try:
        for m in sorted({t["plugin"].split("@")[1] for t in TOOLS.values() if "plugin" in t}):
            try:
                subprocess.run(["claude", "plugin", "marketplace", "update", m], capture_output=True, timeout=120)
            except (OSError, subprocess.TimeoutExpired):
                pass  # offline or no claude on PATH: the page just shows no updates
    finally:
        checking = False


def plugin_update(t: dict) -> dict | None:
    """{"version": newest or None} when the marketplace has a newer commit than the installed one, else None.

    A plugin from the marketplace's own repo (source "./") is as new as that repo's head; one from a URL is
    pinned by the catalog's sha. Either is compared with the gitCommitSha Claude Code recorded at install.
    """
    try:
        name, mkt = t["plugin"].split("@")
        record = json.loads((CLAUDE_DIR / "plugins" / "installed_plugins.json").read_text())["plugins"][t["plugin"]][0]
        clone = CLAUDE_DIR / "plugins" / "marketplaces" / mkt
        entry = next(p for p in json.loads((clone / ".claude-plugin" / "marketplace.json").read_text())["plugins"] if p["name"] == name)
        source = entry["source"]
        if isinstance(source, str):
            latest = subprocess.run(["git", "-C", str(clone), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
            version = json.loads((clone / source / ".claude-plugin" / "plugin.json").read_text()).get("version")
        else:
            latest, version = source.get("sha"), entry.get("version")
    except (OSError, ValueError, KeyError, StopIteration, subprocess.TimeoutExpired):
        return None  # anything missing means "don't know", never a false Update button
    installed = record.get("gitCommitSha")
    if not latest or not installed or latest == installed or version == record.get("version"):
        return None
    return {"version": version}


def state() -> dict:
    settings = load_settings()
    enabled = settings.get("enabled", {})
    shown = settings.get("stats", {})
    root = git_root()
    return {
        "project": PROJECT.name if PROJECT else None,
        "checking": checking,
        "theme": settings.get("theme"),  # the page's light/dark choice; None = follow the system
        "tools": [
            {
                "id": tid,
                "name": t["name"],
                "description": t["description"],
                "repo": t["repo"],
                "installed": is_installed(t),
                "installing": tid in installing,
                # A newer version in the plugin's marketplace, offered as an Update button.
                "update": plugin_update(t) if "plugin" in t and "update" in t and is_installed(t) else None,
                "enabled": enabled.get(tid, True),
                "plugin": "plugin" in t,
                "uninstall": "uninstall" in t,
                # Whether it has anything on the bar: every non-plugin tool, and plugins marked `bar`.
                "bar": "plugin" not in t or t.get("bar", False),
                "stats": [
                    {"key": k, "label": label, "on": shown.get(tid, {}).get(k, True)}
                    for k, label in t.get("stats", {}).items()
                ],
                # The tool's output folder in the session's folder, offered for deletion while it exists.
                "output": None
                if PROJECT is None or "generated" not in t
                else {
                    "folder": t["generated"],
                    "exists": (PROJECT / t["generated"]).exists() or (PROJECT / t["generated"]).is_symlink(),
                    "project": PROJECT.name,
                },
                "mcp": None if PROJECT is None or "mcp" not in t else mcp_state(t["mcp"]),
                # None when the session's folder isn't in a git repo: nothing to ignore it in.
                # Agents the bar copied into this folder, offered for .gitignore (one line each) while any exist.
                "copies": copies_state(t, root),
                "gitignore": None
                if root is None or "generated" not in t
                else {
                    "folder": t["generated"],
                    "ignored": is_ignored(t["generated"]),
                    # Only a rule PENGUIN added can be removed from the page.
                    "ours": added_by_penguin(root, t["generated"]),
                    "repo": root.name,
                },
            }
            for tid, t in TOOLS.items()
        ],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "penguin"

    def log_message(self, *args):  # keep stdout for the plugin's protocol
        pass

    def _host_ok(self) -> bool:
        # Refuse other hostnames pointed at 127.0.0.1 (DNS rebinding).
        host = self.headers.get("Host", "")
        return host in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

    def _authed(self) -> bool:
        # A custom header can't be sent cross-origin without a preflight, which this server never answers.
        return self._host_ok() and hmac.compare_digest(self.headers.get("X-PENGUIN-Token", ""), TOKEN)

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: dict) -> None:
        self._send(code, json.dumps(data).encode(), "application/json")

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, b"forbidden", "text/plain")
        if self.path.split("?")[0] == "/":
            return self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
        if self.path == "/logo.svg":
            try:
                return self._send(200, LOGO.read_bytes(), "image/svg+xml")
            except OSError:
                return self._send(404, b"not found", "text/plain")
        if self.path == "/api/state":
            if not self._authed():
                return self._json(403, {"error": "forbidden"})
            return self._json(200, state())
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if not self._authed():
            return self._json(403, {"error": "forbidden"})
        if self.path == "/api/theme":
            try:
                theme = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 256)) or b"{}").get("theme")
            except (ValueError, AttributeError):
                return self._json(400, {"error": "bad json"})
            if theme not in ("light", "dark"):
                return self._json(400, {"error": "theme must be light or dark"})
            with lock:
                data = load_settings()
                data["theme"] = theme
                save_settings(data)
            return self._json(200, {"theme": theme})
        parts = self.path.strip("/").split("/")  # api/tools/<id>/<action>
        if len(parts) != 4 or parts[:2] != ["api", "tools"] or parts[2] not in TOOLS:
            return self._json(404, {"error": "not found"})
        tid, action = parts[2], parts[3]

        if action in ("enabled", "stats"):
            try:
                length = min(int(self.headers.get("Content-Length", "0")), 1024)
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._json(400, {"error": "bad json"})
            if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
                return self._json(400, {"error": "enabled must be true or false"})

        if action == "stats":
            key = body.get("key")
            if key not in TOOLS[tid].get("stats", {}):
                return self._json(400, {"error": "unknown stat"})
            with lock:
                data = load_settings()
                data.setdefault("stats", {}).setdefault(tid, {})[key] = body["enabled"]
                save_settings(data)
            emit("SETTINGS " + json.dumps(data))
            return self._json(200, state())

        if action == "enabled":
            with lock:
                data = load_settings()
                data.setdefault("enabled", {})[tid] = body["enabled"]
                save_settings(data)
            emit("SETTINGS " + json.dumps(data))
            # Switching a tool on also connects Claude to it, so the bar's figures can come true. Without a graph yet
            # there is nothing to connect: the plugin connects after the first build instead. The switch itself
            # has already been saved, so a connect problem is reported, not failed.
            if body["enabled"] and TOOLS[tid].get("mcp") and PROJECT is not None and mcp_state(TOOLS[tid]["mcp"])["graph"]:
                err = connect(tid)
                if err:
                    return self._json(200, {"warning": f"Shown on the bar, but couldn't connect Claude: {err}", **state()})
            return self._json(200, state())

        if action in ("ignore-copies", "unignore-copies"):
            root = git_root()
            if root is None:
                return self._json(400, {"error": "this folder isn't in a git repository"})
            with lock:
                set_copies_ignored(root, agent_copies(TOOLS[tid]) if action == "ignore-copies" else None)
            return self._json(200, state())

        if action in ("gitignore", "unignore"):
            root, folder = git_root(), TOOLS[tid].get("generated")
            if root is None or folder is None:
                return self._json(400, {"error": "this folder isn't in a git repository"})
            with lock:
                if action == "gitignore" and not is_ignored(folder):
                    add_to_gitignore(root, folder, TOOLS[tid]["name"])
                elif action == "unignore":
                    remove_from_gitignore(root, folder)
            return self._json(200, state())

        if action == "connect":
            err = connect(tid)
            return self._json(400 if err else 200, {"error": err, **state()} if err else state())

        if action == "disconnect":
            spec = TOOLS[tid].get("mcp")
            if PROJECT is None or spec is None:
                return self._json(400, {"error": "no project folder"})
            if mcp_state(spec)["scope"] != "local":
                return self._json(200, state())  # not connected, or a shared .mcp.json PENGUIN doesn't edit
            try:
                r = claude_mcp("remove", spec["name"], "--scope", "local")
            except FileNotFoundError:
                return self._json(500, {"error": "the claude command isn't on PATH", **state()})
            except subprocess.TimeoutExpired:
                return self._json(500, {"error": "claude mcp timed out", **state()})
            if r.returncode != 0:
                err = ((r.stderr.strip() or r.stdout.strip()).splitlines() or ["disconnect failed"])[-1]
                return self._json(500, {"error": err, **state()})
            return self._json(200, state())

        if action == "delete-output":
            folder = TOOLS[tid].get("generated")
            if PROJECT is None or folder is None:
                return self._json(400, {"error": "no project folder"})
            target = PROJECT / folder
            # Only ever the tool's own folder directly inside the session's folder. A symlink is removed as a
            # link, never followed, so nothing outside the project can be deleted through it.
            with lock:
                if target.is_symlink():
                    target.unlink()
                elif target.is_dir():
                    shutil.rmtree(target)
            emit(f"OUTPUT_DELETED {tid}")
            return self._json(200, state())

        if action in ("install", "uninstall", "update"):
            if action not in TOOLS[tid]:
                return self._json(404, {"error": f"{TOOLS[tid]['name']} has no {action} here"})
            with lock:
                if tid in installing:
                    return self._json(409, {"error": "already busy"})
                installing.add(tid)
            try:
                r = subprocess.run(["/bin/sh", "-c", TOOLS[tid][action]], capture_output=True, text=True, timeout=600)
            except subprocess.TimeoutExpired:
                r = None
            finally:
                with lock:
                    installing.discard(tid)
            emit(f"INSTALLED {tid}")  # the plugin re-checks whether the tool is installed either way
            if r is None or r.returncode != 0:
                # `claude plugin` reports some failures on stdout.
                err = "timed out" if r is None else ((r.stderr.strip() or r.stdout.strip()).splitlines() or [f"{action} failed"])[-1]
                return self._json(500, {"error": err, **state()})
            return self._json(200, state())

        self._json(404, {"error": "not found"})


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    emit(f"PORT {srv.server_port}")
    threading.Thread(target=refresh_marketplaces, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
