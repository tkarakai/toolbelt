// Text imports (Bun `with { type: "text" }`): the CLI embeds its skill file.
declare module "*.md" {
	const text: string;
	export default text;
}
