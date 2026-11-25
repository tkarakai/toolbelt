// Agent scenario fixture: a plugin that opts out of agents (`agent.access: none`), like
// Processes. Nothing it renders may reach an agent: not its id, name or content.
import { definePlugin } from "../../../../src/sdk";

definePlugin({
	render: {
		"screen:processes": () => ({
			type: "page",
			summary: "2 processes",
			children: [
				{
					type: "table",
					id: "processes",
					columns: [{ key: "name", title: "Process" }, { key: "port", title: "Port" }],
					rows: [
						{ id: "p1", cells: { name: "node server.js --token=vault-hunter2", port: "3000" } },
						{ id: "p2", cells: { name: "postgres", port: "5432" } },
					],
				},
			],
		}),
	},
});
