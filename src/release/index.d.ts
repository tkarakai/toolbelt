import type { PackageManifest } from "../src/shared/package";
export type Product = "app" | "sdk" | "plugin";
export type ReleaseConfig = {
  repo: string;
  products: Partial<
    Record<
      Product,
      {
        changelog: string;
        version(): string;
        setVersion(version: string): Promise<void>;
        /** Product-specific complete validation; otherwise typecheck and all tests run. */
        validate?(): Promise<void>;
        build(): Promise<string[]>;
      }
    >
  >;
  hostVersion: string;
};
export declare function run(
  args: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<string>;
export declare function json<T = any>(path: string): T;
export declare function save(path: string, value: unknown): void;
export declare function updateJSONVersion(
  path: string,
  version: string,
): Promise<void>;
export declare function packagePlugin(
  root: string,
  output: string,
  hostVersion: string,
  extras?: string[],
): Promise<string[]>;
export declare function verifyPlugin(
  archive: string,
  hostVersion: string,
  expected?: { repo: string; version: string; target: string },
): Promise<PackageManifest>;
export declare function pluginManifest(): PackageManifest;
