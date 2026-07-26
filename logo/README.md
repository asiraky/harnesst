# harnesst logo assets

The harnesst wordmark and icon. The mark is the lowercase word **harnesst** set in Suisse Intl
Bold (tracking −0.029em), with a lariat looped around the final **t** — the working end flicking
off to the right. The initial **h** is pulled out on its own as the app icon / favicon.

The lariat rides at mid-stem, inside the letter height, rather than over the ascender. Two reasons:
crossing a `t` above its crossbar leaves only slivers of letter either side and the glyph stops
reading, and a loop clearing the ascender spends a third of the height budget on empty space —
which is the whole budget at the 20px the app header uses. The icon is the bare `h`: every version
carrying the lariat turned to mush by 32px, so the rope stays the wordmark's signature.

Unlike the set this replaces, these _are_ wired into the app —
`app/components/marketing/logo.tsx` draws the same outlines inline (rope on `--primary`, letters on
`currentColor`) so the marks flip with the theme, and `public/` serves the favicon set.

## Colors

| Token              | Hex       | Use                                                 |
| ------------------ | --------- | --------------------------------------------------- |
| Brand blue (light) | `#4A7DFF` | the lariat, on light grounds — `--primary`          |
| Brand blue (dark)  | `#588AFF` | the lariat, on dark grounds — `--primary` (dark)    |
| Ink                | `#1A1A18` | the letters, on light grounds — `--harnesst-fg`     |
| Off-white          | `#FAF8F4` | the letters, on dark grounds — `--harnesst-band-fg` |

## Wordmark

| File                                               | Notes                                    |
| -------------------------------------------------- | ---------------------------------------- |
| `harnesst-wordmark-light.svg` / `.png` / `@2x.png` | for light backgrounds (ink letters)      |
| `harnesst-wordmark-dark.svg` / `.png` / `@2x.png`  | for dark backgrounds (off-white letters) |

SVGs are outlined (no font dependency) and use no element ids, so several can be inlined in one
document. PNGs are transparent, 897×160 at 1x.

## Icon (the `h`)

| File                              | Notes                                                            |
| --------------------------------- | ---------------------------------------------------------------- |
| `harnesst-icon.svg` / `.png`      | transparent, blue `h` — for light grounds                        |
| `harnesst-icon-dark.svg` / `.png` | transparent, lighter blue `h` — for dark grounds                 |
| `harnesst-icon-tile.svg`          | rounded blue tile, white `h`                                     |
| `favicon.svg`                     | same rounded tile — drop-in favicon                              |
| `favicon.ico`                     | multi-size (16/32/48)                                            |
| `favicon-16/32/48/64.png`         | rounded tile                                                     |
| `apple-touch-icon.svg` / `.png`   | 180×180, full-bleed square (iOS rounds it itself)                |
| `icon-maskable.svg`               | full-bleed square with a wider safe area, for maskable PWA icons |
| `icon-192.png` / `icon-512.png`   | rendered from `icon-maskable.svg`, maskable (PWA)                |
