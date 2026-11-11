import {
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
export function syncPath(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
/** Flush children before their directory entries. Managed symlinks are not followed outside the snapshot. */
export function syncTree(root: string) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory())
    for (const name of readdirSync(root)) syncTree(join(root, name));
  if (stat.isDirectory() || stat.isFile()) syncPath(root);
  else throw new Error("Managed data contains an unsupported special file");
}
/** Include the profile root's parent so newly created storage ancestors are durable too. */
export function syncParents(directory: string, profile: string) {
  let current = resolve(directory);
  const boundary = resolve(profile);
  while (true) {
    syncPath(current);
    if (current === boundary) {
      syncPath(dirname(current));
      return;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
