// Agent scenario fixture: a plugin made before agent access existed, so its manifest declares no
// `agent.access`. Agents can't see it until the person allows reading in Settings → Agents.
import { definePlugin } from "../../../../src/sdk";

definePlugin({
	render: {
		"screen:notes": () => ({
			type: "list",
			id: "notes",
			items: [
				{ id: "n1", title: "Call the plumber about the kitchen tap" },
				{ id: "n2", title: "Book the car service" },
			],
		}),
	},
});
