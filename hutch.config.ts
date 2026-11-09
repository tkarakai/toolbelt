// @hutch cli=0.29.0 cottontail=0.7.3
// Electrobun's build tool. Day-to-day commands live in package.json (`bun run dev`, `bun run
// build`); they call it through the pinned `electrobun` npm bootstrap, which downloads and
// checksum-verifies the matching Hutch release.
export default {
	packageManager: "bun",
	electrobun: {
		version: "2.0.6",
	},
};
