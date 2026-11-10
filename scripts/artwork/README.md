# Running artwork

`AppArt.swift` is copied unchanged from [Running](https://github.com/tkarakai/running),
commit `c9d55727a7b38b4738b31608b8480c1eccebf8d0` (v0.8.0),
`mac/Sources/Running/UI/Common/AppArt.swift`. Both projects have the same author.

`main.swift` exports its midnight-blue official and amber dev iconsets and its menu bar
glyph, including the update badge, to Toolbelt's existing asset paths. Regenerate with
`bun run icons` on macOS with Xcode command line tools. The PNGs are checked in; normal
app builds do not need Swift or a Running checkout.
