"""Scrub host-identifying data from anything the harness writes into the public repo.

Committed files are public (CLAUDE.md, 03 open item 4): no hostnames, usernames,
home-directory paths, tokens, or hardware serials. The manifest writer runs every value
through `Scrubber.obj` and then `Scrubber.leaks` as a final guard.
"""

from __future__ import annotations

import getpass
import ipaddress
import os
import re
import socket
from dataclasses import dataclass, field

# Generic account names that are also ordinary words; scrubbing them as bare words would
# mangle text ("user-specified"). They are still scrubbed inside paths and user@host.
_GENERIC_USERS = {"user", "users", "root", "admin", "ubuntu", "runner", "debian", "ec2-user", "nvidia"}
_GENERIC_HOSTS = {"localhost", "localhost.localdomain", "ubuntu", "debian"}

SECRET_KEY_RE = re.compile(r"(token|secret|passw(or)?d|api[_-]?key|authorization|cookie|credential)", re.IGNORECASE)
TOKEN_PATTERNS = (
    re.compile(r"\bhf_[A-Za-z0-9]{20,}\b"),  # Hugging Face
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),  # GitHub
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),  # OpenAI-style / Anthropic
    re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),  # AWS access key id
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
)
GPU_UUID_RE = re.compile(r"\b(GPU|MIG)-[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b")
MAC_RE = re.compile(r"\b[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}\b")
IPV4_RE = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
HOME_PATH_RE = re.compile(r"(/home|/Users)/[^/\s\"':]+")
ROOT_HOME_RE = re.compile(r"(?<![\w.])/root(?=/|\b)")


# Private and link-local ranges are scrubbed wherever they appear; a public address only if
# it is one of this host's (vLLM logs its own IP in distributed_init_method). Matching every
# dotted quad would also eat four-part package versions such as cuDNN's 9.19.0.56.
_PRIVATE_NETS = tuple(
    ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10")
)


def _sensitive_ip(text: str, host_ips: set[str]) -> bool:
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_unspecified:
        return False
    return text in host_ips or any(ip in n for n in _PRIVATE_NETS)


@dataclass
class Scrubber:
    home: str = field(default_factory=lambda: os.path.expanduser("~"))
    user: str = field(default_factory=lambda: _safe(getpass.getuser))
    hostnames: set[str] = field(default_factory=lambda: _local_hostnames())
    host_ips: set[str] = field(default_factory=lambda: _local_ips())
    # Where the checkout lives is personal too (vLLM logs site-packages paths in the venv).
    repo_root: str = field(default_factory=lambda: _repo_root())

    def __post_init__(self) -> None:
        self.home = self.home.rstrip("/")
        self.repo_root = self.repo_root.rstrip("/")
        hosts = {h for h in self.hostnames if h and h.lower() not in _GENERIC_HOSTS}
        # Also scrub the short name of an FQDN.
        hosts |= {h.split(".")[0] for h in hosts if "." in h and len(h.split(".")[0]) >= 3}
        self._host_res = [re.compile(rf"(?<![\w-]){re.escape(h)}(?![\w-])", re.IGNORECASE) for h in sorted(hosts, key=len, reverse=True)]
        self._user_word = (
            re.compile(rf"(?<![\w-]){re.escape(self.user)}(?![\w-])")
            if self.user and len(self.user) >= 3 and self.user.lower() not in _GENERIC_USERS
            else None
        )
        self._user_at = re.compile(rf"\b{re.escape(self.user)}@") if self.user else None

    def text(self, s: str) -> str:
        if not s:
            return s
        if self.repo_root and self.repo_root not in ("", "/"):
            s = s.replace(self.repo_root, "<repo>")
        if self.home and self.home not in ("", "/"):
            s = s.replace(self.home, "~")
        s = HOME_PATH_RE.sub("~", s)
        s = ROOT_HOME_RE.sub("~", s)
        for pat in TOKEN_PATTERNS:
            s = pat.sub("<redacted-token>", s)
        s = GPU_UUID_RE.sub("<gpu-uuid>", s)
        s = MAC_RE.sub("<mac>", s)
        s = IPV4_RE.sub(lambda m: "<ip>" if _sensitive_ip(m.group(0), self.host_ips) else m.group(0), s)
        if self._user_at:
            s = self._user_at.sub("<user>@", s)
        for pat in self._host_res:
            s = pat.sub("<host>", s)
        if self._user_word:
            s = self._user_word.sub("<user>", s)
        return s

    def obj(self, o):
        """Recursively scrub a JSON-like structure. String values under secret-looking keys
        are replaced outright (secrets are strings; `first_token: 12.5` is a timestamp)."""
        if isinstance(o, dict):
            out = {}
            for k, v in o.items():
                key = self.text(str(k))
                if isinstance(v, str) and v and SECRET_KEY_RE.search(str(k)) and not _is_harmless_secret_key(str(k)):
                    out[key] = "<redacted>"
                    continue
                out[key] = self.obj(v)
            return out
        if isinstance(o, (list, tuple)):
            return [self.obj(v) for v in o]
        if isinstance(o, str):
            return self.text(o)
        return o

    def leaks(self, s: str) -> list[str]:
        """Things that should never survive scrubbing. Empty list means clean."""
        found = []
        if self.home and self.home not in ("", "/") and self.home in s:
            found.append("home directory path")
        if HOME_PATH_RE.search(s):
            found.append("/home/<name> path")
        for pat in self._host_res:
            if pat.search(s):
                found.append("hostname")
                break
        if self._user_word and self._user_word.search(s):
            found.append("username")
        for pat in TOKEN_PATTERNS:
            if pat.search(s):
                found.append("token")
                break
        if GPU_UUID_RE.search(s):
            found.append("GPU UUID")
        if any(_sensitive_ip(m.group(0), self.host_ips) for m in IPV4_RE.finditer(s)):
            found.append("IP address")
        return found


# Keys whose names match SECRET_KEY_RE but carry benchmark data, not secrets: token
# *counts* (plural), tokenizer ids, throughputs. A singular "..._token" key stays redacted.
_HARMLESS = re.compile(r"(tokens|tokenizer|token_throughput|token_ids)", re.IGNORECASE)


def _is_harmless_secret_key(k: str) -> bool:
    if re.search(r"(secret|passw|api[_-]?key|authorization|cookie|credential)", k, re.IGNORECASE):
        return False
    return bool(_HARMLESS.search(k))


def _safe(fn) -> str:
    try:
        return fn() or ""
    except Exception:
        return os.environ.get("USER", "")


def _local_hostnames() -> set[str]:
    names = set()
    for fn in (socket.gethostname, socket.getfqdn, lambda: os.uname().nodename):
        try:
            n = fn()
        except Exception:
            continue
        if n:
            names.add(n)
    return names


def _repo_root() -> str:
    from . import PROJECT_ROOT  # benchmarks/; its parent is the checkout

    return str(PROJECT_ROOT.parent)


def _local_ips() -> set[str]:
    ips: set[str] = set()
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    return {ip for ip in ips if not ip.startswith("127.")}


def safe_env(env: dict[str, str], allow_prefixes: tuple[str, ...] = ("VLLM_", "CUDA_", "HF_HUB_OFFLINE", "NCCL_", "PYTHON", "NO_COLOR", "DO_NOT_TRACK", "TOKENIZERS_", "OMP_")) -> dict[str, str]:
    """Only allowlisted environment variables ever reach a manifest."""
    return {k: v for k, v in sorted(env.items()) if k.startswith(allow_prefixes) and not SECRET_KEY_RE.search(k)}
