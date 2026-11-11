console.error('Use bun run release:app or release:sdk --version X.Y.Z --channel stable|prerelease [--check]. Merging the release PR authorizes CI publication.');
process.exitCode = 1;
