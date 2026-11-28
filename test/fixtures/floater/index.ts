// Test plugin: a floating plugin without screens. It starts as an ask bar; sending a question
// turns it into a panel with the conversation; `env` toasts the agent command it was given.
import { definePlugin, type Message, type Node } from "../../../src/sdk";

const messages: Message[] = [];
definePlugin({
	render: {
		floating: (): Node => ({
			type: "floating",
			mode: messages.length ? "panel" : "bar",
			subtitle: "Test",
			actions: [{ id: "env", label: "Agent command", icon: "terminal" }],
			suggestions: [{ id: "ask-hello", label: "Say hello", icon: "hand" }],
			children: [
				...(messages.length ? [{ type: "conversation", id: "chat", messages } as Node] : []),
				{ type: "composer", id: "ask", single: true, placeholder: "Ask…", action: { id: "send", label: "Ask" } },
			],
		}),
	},
	onEvent(_surface, name, payload, ctx) {
		if (name === "env") return ctx.toast(`agent ${process.env.TOOLBELT_AGENT_COMMAND ?? "none"}`);
		const text = name === "ask-hello" ? "hello" : (payload as { text?: string }).text;
		if (!text) return;
		messages.push({ role: "user", text }, { role: "assistant", text: `you said ${text}` });
		ctx.invalidate();
	},
});
