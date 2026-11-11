"""Checks that all 15 locales have exactly the keys of the German source
and the same {placeholders}. Usage: python tests/i18n-check.py"""
import json, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent / "app" / "src" / "i18n" / "locales"
line = re.compile(r'^\s*("(?:[^"\\]|\\.)+"):\s*("(?:[^"\\]|\\.)*"),?\s*$', re.M)
holes = re.compile(r"\{(\w+)\}")


def load(name):
    text = (root / name).read_text(encoding="utf-8")
    return {json.loads(k): json.loads(v) for k, v in line.findall(text)}


de = load("de.ts")
failed = False
for f in sorted(root.glob("*.ts")):
    d = load(f.name)
    missing = [k for k in de if k not in d]
    extra = [k for k in d if k not in de]
    bad = [k for k in d if k in de and sorted(holes.findall(d[k])) != sorted(holes.findall(de[k]))]
    empty = [k for k, v in d.items() if not v.strip()]
    ok = not (missing or extra or bad or empty)
    failed |= not ok
    print(f"{f.name}: {len(d)} keys" + ("" if ok else f"  missing={missing[:5]} extra={extra[:5]} placeholders={bad[:5]} empty={empty[:5]}"))
print("FAILED" if failed else f"all locales complete ({len(de)} keys)")
sys.exit(1 if failed else 0)
