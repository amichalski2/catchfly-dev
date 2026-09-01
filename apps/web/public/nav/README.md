# Nav plates

Five flat vector plates, one per rail entry. `overview`, `regression` and `cases`
were made first; `releases` and `sessions` were added later to the same recipe.

Generated with the `nav` profile in `.claude/art-profile.toml`:

```
uv run ~/.claude/skills/fal-assets/scripts/falgen.py edit --profile nav -n 1 \
  --prompt "<one object from a reviewer's desk>"
```

`source/*.png` are rasterised copies of the first three plates, used as the
profile's style references.

## gpt-image-2 will not produce this palette

It returns the right composition in warm sepia every time — brown leaves, a
near-black outline, no sage anywhere — however forcefully the style block or a
`redo --tweak` states the hex values. Two rounds were spent establishing that.

The fix is deterministic rather than another round. recraft returns flat SVG with
about five distinct `rgb()` fills, which map onto the five brand colours by
lightness plus one red-dominance test to separate blush pink from cream:

| test | colour |
|---|---|
| `l < 0.25` | `#1E2E20` outline |
| `l < 0.45` | `#304430` deep |
| `(r - g) > 30` and `abs(g - b) < 15` | `#EBB8B6` pink |
| `l > 0.78` | `#F1E5CB` cream |
| otherwise | `#919971` sage |

So: generate for composition, remap for palette. `releases.svg` and
`sessions.svg` were both produced this way, and the remap now lives in
`scripts/remap-nav-palette.py` rather than being retyped per run:

```
python3 scripts/remap-nav-palette.py [--cream-above=L] <svg> …
```

`--cream-above` moves the cream/sage split off its 0.78 default, for a plate
whose object comes back at the same lightness as its leaves.
