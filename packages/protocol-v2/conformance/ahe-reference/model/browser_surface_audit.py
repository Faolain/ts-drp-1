#!/usr/bin/env python3
"""Static browser-surface and deterministic-core audit for the AHE reference code."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = (ROOT / "src", ROOT / "browser")
FORBIDDEN = {
    "node_builtin_import": re.compile(r"(?:from\s+|import\s*\()[\"']node:"),
    "commonjs_require": re.compile(r"\brequire\s*\("),
    "node_buffer": re.compile(r"\bBuffer\b"),
    "node_process": re.compile(r"\b(?:globalThis\.)?process\.(?:env|version|platform|arch|memoryUsage|cwd|exit|argv)\b"),
    "path_globals": re.compile(r"\b(?:__dirname|__filename)\b"),
    "sync_xhr": re.compile(r"\.open\s*\([^,]+,[^,]+,\s*false\s*\)"),
    "web_storage": re.compile(r"\b(?:localStorage|sessionStorage)\b"),
    "eval": re.compile(r"\b(?:eval|Function)\s*\("),
}
SEMANTIC_MODULES = {
    "admission.js",
    "archive.js",
    "canonical.js",
    "ct-merkle.js",
    "fold.js",
    "hash.js",
    "linearize.js",
    "protocol.js",
    "seal.js",
    "snapshot.js",
    "state.js",
}
NONDETERMINISM = {
    "wall_clock": re.compile(r"\b(?:Date\.now|new\s+Date|performance\.now)\s*\("),
    "random": re.compile(r"\b(?:Math\.random|crypto\.randomUUID|getRandomValues)\s*\("),
    "json_hashing": re.compile(r"JSON\.stringify\s*\("),
}


def scan(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    return {
        "path": str(path.relative_to(ROOT)),
        "bytes": len(text.encode("utf-8")),
        "lines": text.count("\n") + 1,
        "forbidden": {name: [m.start() for m in pattern.finditer(text)] for name, pattern in FORBIDDEN.items() if pattern.search(text)},
        "semantic_nondeterminism": {
            name: [m.start() for m in pattern.finditer(text)]
            for name, pattern in NONDETERMINISM.items()
            if path.name in SEMANTIC_MODULES and pattern.search(text)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    files = sorted(path for directory in SOURCE_DIRS for path in directory.glob("*.js"))
    modules = [scan(path) for path in files]
    violations = [module for module in modules if module["forbidden"] or module["semantic_nondeterminism"]]
    result = {
        "model": "browser-surface-static-audit-v1",
        "modules": len(modules),
        "source_bytes": sum(module["bytes"] for module in modules),
        "source_lines": sum(module["lines"] for module in modules),
        "forbidden_patterns": sorted(FORBIDDEN),
        "semantic_nondeterminism_patterns": sorted(NONDETERMINISM),
        "violations": violations,
        "notes": [
            "Date.now in indexeddb-store.js is intentionally excluded: it labels operational journal records and never participates in hashes, admission, ordering, authorization, or state folds.",
            "setTimeout/performance.now in runtime.js are cooperative scheduling helpers and are intentionally outside semantic decisions.",
        ],
        "verdict": "pass" if not violations else "fail",
    }
    Path(args.output).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    if violations:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
