import { test, expect } from "bun:test";
import { safeSvg } from "../src/bun/plugin-assets";
test("safe static SVG styling remains usable while executable/external SVG rejects", () => {
  expect(
    safeSvg(
      '<svg style="flex:none;line-height:1"><path fill="currentColor" d="M0 0"/></svg>',
    ),
  ).toBe(true);
  for (const svg of [
    '<svg onload="alert(1)"/>',
    "<svg><script>alert(1)</script></svg>",
    '<!DOCTYPE svg SYSTEM "https://example.test"><svg/>',
    "<svg><x:script/></svg>",
    '<svg><style>@import "https://example.test"</style></svg>',
    '<svg style="fill:&#117;rl(https://example.test)"/>',
    '<svg><image href="https://example.test"/></svg>',
  ])
    expect(safeSvg(svg)).toBe(false);
});
