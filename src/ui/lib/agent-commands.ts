// The commands Settings → Agents offers to paste (docs/agent-interface.md): adding ToolBelt to
// agents, and removing it again. Pure, so tests can check them.

export type CommandTab = { id: string; label: string; text: string; note: string };

/** Shell-quoted, for pasting into a terminal. */
export const shell = (argv: string[]) => argv.map((a) => (/^[\w./=:@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

/** Commands that add ToolBelt to agents, and remove it again. Removing works with agents off. */
export function connectCommands(command: string[]): { title: string; tabs: CommandTab[] }[] {
	const cli = shell(command);
	const server = shell([...command, "mcp"]);
	const config = JSON.stringify({ mcpServers: { toolbelt: { command: command[0], args: [...command.slice(1), "mcp"] } } }, null, 2);
	return [
		{
			title: "Claude Code",
			tabs: [
				{ id: "add", label: "Add", text: `claude mcp add --scope user toolbelt -- ${server}`, note: "Adds ToolBelt as an MCP server for all your projects." },
				{ id: "remove", label: "Remove", text: "claude mcp remove --scope user toolbelt", note: "Removes ToolBelt from Claude Code’s MCP servers." },
			],
		},
		{
			title: "Codex",
			tabs: [
				{ id: "add", label: "Add", text: `codex mcp add toolbelt -- ${server}`, note: "Adds ToolBelt to Codex’s MCP servers (~/.codex/config.toml)." },
				{ id: "remove", label: "Remove", text: "codex mcp remove toolbelt", note: "Removes ToolBelt from Codex’s MCP servers." },
			],
		},
		{
			title: "Claude Desktop and other MCP clients",
			tabs: [
				{ id: "json", label: "JSON", text: config, note: "Merge into the client’s MCP settings (Claude Desktop: Settings → Developer → Edit Config). To remove ToolBelt, delete its toolbelt entry there." },
				{ id: "command", label: "Command", text: server, note: "Starts ToolBelt’s MCP server on stdio, for clients that ask for a command." },
			],
		},
		{
			title: "The toolbelt command",
			tabs: [
				{ id: "add", label: "Add", text: `alias toolbelt=${shell([cli])}`, note: "Paste into your shell profile (~/.zshrc), open a new terminal and try toolbelt status." },
				{ id: "remove", label: "Remove", text: "unalias toolbelt", note: "Ends the alias in this terminal. Also delete the alias line from your shell profile." },
			],
		},
		{
			title: "Skill file for coding agents",
			tabs: [
				{ id: "add", label: "Add", text: `mkdir -p ~/.claude/skills/toolbelt && ${cli} skill > ~/.claude/skills/toolbelt/SKILL.md`, note: "Teaches Claude Code to use the toolbelt command." },
				{ id: "remove", label: "Remove", text: "rm -rf ~/.claude/skills/toolbelt", note: "Deletes the skill file and its folder." },
			],
		},
	];
}
