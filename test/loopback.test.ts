import { test, expect } from "bun:test";
import { localControlRequest } from "../src/bun/loopback";
test("development execution controls reject cross-site origins and rebound hosts", () => {
  expect(localControlRequest(new Request("http://127.0.0.1:47811/state"))).toBe(
    true,
  );
  expect(
    localControlRequest(
      new Request("http://localhost:5174/rpc", {
        headers: { Origin: "http://localhost:5174" },
      }),
    ),
  ).toBe(true);
  expect(
    localControlRequest(
      new Request("http://127.0.0.1:47811/control", {
        headers: { Origin: "https://untrusted.example" },
      }),
    ),
  ).toBe(false);
  expect(
    localControlRequest(
      new Request("http://untrusted.example:47811/control", {
        headers: { Origin: "http://untrusted.example:47811" },
      }),
    ),
  ).toBe(false);
});
