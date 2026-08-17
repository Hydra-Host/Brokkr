"""Fetch an OS-layers manifest (release index or versioned manifest) as JSON to stdout — server-side
because the Cloudflare-fronted host blocks the default UA. ``--url-only`` prints the resolved URL only."""

from __future__ import annotations

import json
import sys

from local.config import get_settings
from local.seed.os_catalog import http_get_json


def main(argv: list[str]) -> None:
    url_only = "--url-only" in argv
    argv = [a for a in argv if a != "--url-only"]
    url = argv[0] if argv else get_settings().sim.os_layers_manifest_index_url
    resolved = url
    doc = http_get_json(url)
    if "layers" not in doc:
        follow = doc.get("url")
        if not follow:
            raise SystemExit(f"{url} is neither a manifest ('layers') nor an index ('url')")
        resolved = follow
        doc = http_get_json(follow)
    print(resolved if url_only else json.dumps(doc))


if __name__ == "__main__":
    main(sys.argv[1:])
