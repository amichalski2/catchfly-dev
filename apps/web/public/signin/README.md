# Sign-in plates

Three watercolour spot illustrations for the panel beside the sign-in form, made
with the same `card` profile as `brand/cards`, so the sign-in panel and the
findings cards read as one family. They replaced an earlier flat-vector set made
with the `nav` profile, which sat in the rail's idiom rather than the panel's.

| file | object | point it carries |
|---|---|---|
| `compare.webp` | a balance scale | Track and compare |
| `find.webp` | a card index drawer | Find what matters |
| `ship.webp` | a wax-sealed envelope | Ship with confidence |

```
uv run ~/.claude/skills/fal-assets/scripts/falgen.py edit --profile card \
  --background birefnet -n 1 --prompt "<one object from a reviewer's desk>"
```

The `card` profile paints onto cream and declares no cutout, which is right for
the findings cards but not here: the panel behind these is blush, so a cream
ground would show as a square. `--background birefnet` takes the ground off and
leaves the soft edge the wash fades into.

The cutouts are then trimmed to the alpha bounding box, re-centred on a square
with a 6% margin and resized to 440px — the same box the findings cards use.
Without the trim each plate keeps whatever margin the model happened to leave,
and at 56px the three objects come out at three different sizes.
