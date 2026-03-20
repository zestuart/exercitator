#!/usr/bin/env python3
"""SAST scanner using Gemini 2.5 Pro — zero external dependencies.

Collects source files from the repository and sends them to Google's Gemini API
for static application security testing. Uses context caching to reduce cost on
repeated scans.

Part of the Armature framework for AI-assisted development.

Modes:
  full  - scan all source files
  diff  - scan only files changed since the last sast-baseline-* git tag
          (full source is still cached for context; diff instruction focuses review)

Environment:
  GEMINI_API_KEY  - required; get one at https://aistudio.google.com/apikey
  GEMINI_MODEL    - optional; defaults to gemini-2.5-pro

Exit codes:
  0 - no findings (or no files to scan)
  1 - findings reported
  2 - error (missing API key, network failure, etc.)
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_STATE_FILE = REPO_ROOT / ".sast-cache.json"

# Directories excluded from scanning — adjust per project
EXCLUDE_PATTERNS = {
    "tests/",
    "test/",
    "spec/",
    "__pycache__/",
    "node_modules/",
    ".claude/",
    ".github/",
    ".git/",
    ".venv/",
    "venv/",
    "env/",
    "dist/",
    "build/",
    "target/",
    "vendor/",
    "scripts/sast_scan.py",
}

# File extensions to scan — covers common web/API stacks
INCLUDE_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".rb", ".java", ".kt", ".cs",
    ".html", ".htm", ".vue", ".svelte",
    ".sql", ".graphql", ".gql",
    ".toml", ".yml", ".yaml", ".json",
    ".sh", ".bash",
    ".tf", ".hcl",
    ".php",
}

# Config files to include regardless of extension
INCLUDE_FILES = {
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "requirements.txt",
    "Gemfile",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    ".htaccess",
    "nginx.conf",
}

# Maximum file size to include (512 KB) — skip large generated/data files
MAX_FILE_SIZE = 512 * 1024


def build_system_instruction():
    """Build the SAST methodology prompt, incorporating project-specific context."""
    base = """\
Role: You are a Senior Security Consultant and SAST Expert. Your objective is to \
identify vulnerabilities that could lead to account takeovers, data breaches, \
denial of service, or unauthorised access.

Methodology:
1. Review SECURITY.md for previously fixed and acknowledged risks — do not re-report these
2. Check for injection vulnerabilities (SQL, template, command, prompt, XSS, SSRF)
3. Audit authentication and session handling
4. Look for broken access control (BOLA/IDOR, privilege escalation)
5. Check for resource exhaustion (unbounded inputs, missing rate limits, memory bombs)
6. Verify secrets are not hardcoded or leaked (API keys, tokens, passwords in source)
7. Check for insecure dependencies or configurations
8. Review security headers (CORS, CSP, HSTS) if applicable
9. Check infrastructure-as-code for misconfigurations (overly permissive rules, \
missing encryption, public access to private resources, insecure TLS)
10. Look for insecure deserialization, path traversal, and open redirects"""

    # Load project-specific security context from CLAUDE.md if available
    claude_md = REPO_ROOT / "CLAUDE.md"
    if claude_md.exists():
        content = claude_md.read_text()
        # Extract security surfaces section if present
        if "## Security" in content or "### Security surfaces" in content:
            base += "\n\nProject-specific context is provided in CLAUDE.md and " \
                    "SECURITY.md within the source bundle."

    return base


def get_all_source_files():
    """Collect all scannable source files."""
    files = []
    for ext in INCLUDE_EXTENSIONS:
        files.extend(REPO_ROOT.rglob(f"*{ext}"))
    for name in INCLUDE_FILES:
        for match in REPO_ROOT.rglob(name):
            files.append(match)

    filtered = []
    for f in files:
        if not f.is_file():
            continue
        rel = str(f.relative_to(REPO_ROOT))
        if any(excl in rel for excl in EXCLUDE_PATTERNS):
            continue
        if f.suffix not in INCLUDE_EXTENSIONS and f.name not in INCLUDE_FILES:
            continue
        try:
            if f.stat().st_size > MAX_FILE_SIZE:
                continue
        except OSError:
            continue
        filtered.append(f)

    return sorted(set(filtered))


def get_changed_files(baseline_tag):
    """Get list of files changed since baseline tag."""
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{baseline_tag}..HEAD"],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    status = subprocess.run(
        ["git", "diff", "--name-only"],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    staged = subprocess.run(
        ["git", "diff", "--name-only", "--cached"],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    names = set()
    for output in [result.stdout, status.stdout, staged.stdout]:
        for line in output.strip().split("\n"):
            if line:
                names.add(line)
    return sorted(names)


def build_source_bundle(files):
    """Build source code text and compute content hash."""
    parts = []
    total_bytes = 0
    for f in files:
        rel = str(f.relative_to(REPO_ROOT))
        try:
            content = f.read_text()
            total_bytes += len(content)
            parts.append(f"--- {rel} ---\n{content}")
        except (UnicodeDecodeError, PermissionError):
            continue

    bundle = "\n".join(parts)
    content_hash = hashlib.sha256(bundle.encode()).hexdigest()[:16]
    return bundle, total_bytes, content_hash


def build_cached_content(source_bundle):
    """Build the content to cache: security docs + full source code."""
    security_context = ""
    for doc in ["SECURITY.md", "CLAUDE.md"]:
        path = REPO_ROOT / doc
        if path.exists():
            try:
                security_context += f"\n\n## {doc}\n\n{path.read_text()}"
            except (UnicodeDecodeError, PermissionError):
                pass

    return f"""## Project Documentation & Security Context
{security_context}

## Source Code to Audit

{source_bundle}"""


def build_audit_instruction(mode, changed_files=None):
    """Build the mode-specific audit instruction."""
    if mode == "diff" and changed_files:
        file_list = "\n".join(f"- {f}" for f in changed_files)
        return f"""FOCUS: You are reviewing files that changed since the last security baseline. \
Identify NEW vulnerabilities introduced by these changes. Do not flag issues in \
unchanged code paths unless the changes create a new interaction that is vulnerable.

Changed files:
{file_list}

Perform your audit now. For each finding, use this format:

**Severity**: Critical / High / Medium / Low
**Vulnerability**: Concise title
**Description**: Explain the flaw and potential impact
**Evidence**: Reference specific file and line
**Remediation**: Provide a code-level fix

If you find NO new vulnerabilities beyond what is already documented in SECURITY.md, \
respond with exactly: NO_FINDINGS: No new vulnerabilities identified."""
    else:
        return """Perform a full security audit now. For each finding, use this format:

**Severity**: Critical / High / Medium / Low
**Vulnerability**: Concise title
**Description**: Explain the flaw and potential impact
**Evidence**: Reference specific file and line
**Remediation**: Provide a code-level fix

If you find NO new vulnerabilities beyond what is already documented in SECURITY.md, \
respond with exactly: NO_FINDINGS: No new vulnerabilities identified."""


# --- Gemini API helpers (stdlib only — no external dependencies) ---

def _api_url(path, api_key):
    return f"https://generativelanguage.googleapis.com/v1beta/{path}?key={api_key}"


def _api_request(url, payload=None, method="POST"):
    """Make an API request, return parsed JSON."""
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Gemini API error ({e.code}): {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}")


def create_cache(api_key, model, source_content, system_instruction):
    """Create a cached content resource. Returns the cache name."""
    url = _api_url("cachedContents", api_key)
    payload = {
        "model": f"models/{model}",
        "systemInstruction": {
            "parts": [{"text": system_instruction}],
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": source_content}],
            },
        ],
        "ttl": "300s",
    }

    result = _api_request(url, payload)
    cache_name = result.get("name")
    if not cache_name:
        raise RuntimeError(f"Cache creation failed: {json.dumps(result, indent=2)}")

    usage = result.get("usageMetadata", {})
    cached_tokens = usage.get("totalTokenCount", "?")
    print(f"Cache created: {cache_name} ({cached_tokens} tokens cached)", file=sys.stderr)
    return cache_name


def delete_cache(api_key, cache_name):
    """Delete a cached content resource. Ignores errors."""
    try:
        url = _api_url(cache_name, api_key)
        _api_request(url, method="DELETE")
    except Exception:
        pass


def validate_cache(api_key, cache_name):
    """Check if a cache still exists and is valid."""
    try:
        url = _api_url(cache_name, api_key)
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return result.get("name") == cache_name
    except Exception:
        return False


def load_cache_state():
    """Load cached state from local file."""
    if CACHE_STATE_FILE.exists():
        try:
            return json.loads(CACHE_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_cache_state(state):
    """Save cache state to local file."""
    CACHE_STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")


def get_or_create_cache(api_key, model, source_content, content_hash, system_instruction):
    """Get existing cache or create a new one. Returns cache name."""
    state = load_cache_state()

    if (
        state.get("content_hash") == content_hash
        and state.get("model") == model
        and state.get("cache_name")
    ):
        cache_name = state["cache_name"]
        if validate_cache(api_key, cache_name):
            print(f"Cache hit: {cache_name}", file=sys.stderr)
            return cache_name
        print("Cache expired, creating new one...", file=sys.stderr)

    old_cache = state.get("cache_name")
    if old_cache:
        delete_cache(api_key, old_cache)

    cache_name = create_cache(api_key, model, source_content, system_instruction)
    save_cache_state({
        "cache_name": cache_name,
        "content_hash": content_hash,
        "model": model,
    })
    return cache_name


def call_gemini_with_cache(cache_name, instruction, api_key, model):
    """Call Gemini generateContent using a cached context."""
    url = _api_url(f"models/{model}:generateContent", api_key)

    payload = {
        "cachedContent": cache_name,
        "contents": [
            {
                "role": "user",
                "parts": [{"text": instruction}],
            },
        ],
        "generationConfig": {
            "maxOutputTokens": 65536,
            "temperature": 0.1,
        },
    }

    try:
        result = _api_request(url, payload)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)

    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        print(
            f"Unexpected API response: {json.dumps(result, indent=2)}",
            file=sys.stderr,
        )
        sys.exit(2)

    usage = result.get("usageMetadata", {})
    if usage:
        inp = usage.get("promptTokenCount", "?")
        cached = usage.get("cachedContentTokenCount", "?")
        out = usage.get("candidatesTokenCount", "?")
        thought = usage.get("thoughtsTokenCount", 0)
        print(
            f"Gemini tokens — input: {inp} (cached: {cached}), "
            f"output: {out}, thinking: {thought}",
            file=sys.stderr,
        )

    finish = result.get("candidates", [{}])[0].get("finishReason", "?")
    if finish not in ("STOP", "?"):
        print(f"WARNING: finishReason={finish} (response may be truncated)", file=sys.stderr)

    return text


def get_latest_baseline_tag():
    """Find the most recent sast-baseline-* git tag."""
    result = subprocess.run(
        ["git", "tag", "-l", "sast-baseline-*", "--sort=-version:refname"],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    tags = [t for t in result.stdout.strip().split("\n") if t]
    return tags[0] if tags else None


def load_env_file():
    """Load GEMINI_API_KEY from .env if not in environment."""
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        try:
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip("'\"")
                if key == "GEMINI_API_KEY" and value:
                    return value
        except (UnicodeDecodeError, PermissionError):
            pass
    return None


def main():
    parser = argparse.ArgumentParser(
        description="SAST scanner using Gemini 2.5 Pro (Armature framework)"
    )
    parser.add_argument(
        "--mode", choices=["full", "diff"], default="full",
        help="full = all source files; diff = changes since last sast-baseline tag",
    )
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY") or load_env_file()
    if not api_key:
        print(
            "Error: GEMINI_API_KEY not set.\n"
            "Get one free at: https://aistudio.google.com/apikey\n"
            "Add it to your .env file: GEMINI_API_KEY=<your-key>",
            file=sys.stderr,
        )
        sys.exit(2)

    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-pro")

    baseline_tag = None
    changed_files = None
    if args.mode == "diff":
        baseline_tag = get_latest_baseline_tag()
        if not baseline_tag:
            print(
                "No sast-baseline-* tag found. Falling back to full scan.",
                file=sys.stderr,
            )
            args.mode = "full"
        else:
            changed_files = get_changed_files(baseline_tag)
            if not changed_files:
                print("No files changed since baseline.")
                sys.exit(0)

    all_files = get_all_source_files()
    if not all_files:
        print("No files to scan.")
        sys.exit(0)

    source_bundle, source_bytes, content_hash = build_source_bundle(all_files)
    cached_content = build_cached_content(source_bundle)
    system_instruction = build_system_instruction()

    print(f"Mode: {args.mode}", file=sys.stderr)
    if baseline_tag:
        print(f"Baseline: {baseline_tag}", file=sys.stderr)
        print(f"Changed files: {len(changed_files)}", file=sys.stderr)
    print(f"Files (total): {len(all_files)}", file=sys.stderr)
    print(f"Source: {source_bytes:,} bytes", file=sys.stderr)
    print(f"Content hash: {content_hash}", file=sys.stderr)
    print(f"Model: {model}", file=sys.stderr)

    cache_name = get_or_create_cache(
        api_key, model, cached_content, content_hash, system_instruction
    )

    instruction = build_audit_instruction(args.mode, changed_files)
    print("Calling Gemini...", file=sys.stderr)
    result = call_gemini_with_cache(cache_name, instruction, api_key, model)
    print(result)

    # Clean up cache immediately to avoid storage charges
    delete_cache(api_key, cache_name)
    if CACHE_STATE_FILE.exists():
        CACHE_STATE_FILE.unlink()

    if "NO_FINDINGS" in result:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
