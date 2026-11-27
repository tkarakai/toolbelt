// Plugin secrets (capability `secrets`): values a plugin needs, such as API keys, kept in the
// macOS login Keychain by ToolBelt rather than in plugin settings, trees, events or logs.
//
// Each plugin's items share one Keychain service bound to its id, its publisher (the GitHub
// repository it's installed from) and, outside the official profile, the profile, so another
// publisher's package with the same id, ToolBelt Dev, test profiles and plugin development mode
// never see each other's items. The account is the secret's name; the label reads
// "ToolBelt · <plugin> · <name>" in Keychain Access.
import { createHash } from "node:crypto";
import { LIMITS, SECRET_NAME } from "../shared/package";
import type { EnvironmentEntry, Field, Node } from "../shared/protocol";
import type { KeychainRequest, KeychainResponse } from "./keychain-worker";
// @ts-expect-error: the worker's own source, as text (Bun `type: "text"`), started as a blob worker.
import keychainWorker from "./keychain-worker.ts" with { type: "text" };

/** Where secrets are stored. The host uses the Keychain; tests and the browser preview, memory. */
export interface SecretBackend {
	get(service: string, name: string): Promise<string | null>;
	set(service: string, name: string, value: string, label: string): Promise<void>;
	delete(service: string, name: string): Promise<void>;
	/** The names stored under a service (never their values). */
	list(service: string): Promise<string[]>;
}

/** Secrets in memory, for tests and the browser preview: gone when the process ends. */
export class MemorySecretBackend implements SecretBackend {
	readonly items = new Map<string, Map<string, { value: string; label: string }>>();
	async get(service: string, name: string) {
		return this.items.get(service)?.get(name)?.value ?? null;
	}
	async set(service: string, name: string, value: string, label: string) {
		let of = this.items.get(service);
		if (!of) this.items.set(service, (of = new Map()));
		of.set(name, { value, label });
	}
	async delete(service: string, name: string) {
		this.items.get(service)?.delete(name);
	}
	async list(service: string) {
		return [...(this.items.get(service)?.keys() ?? [])];
	}
}

/** How long a Keychain call may wait, including for the person to answer a macOS access prompt. */
const KEYCHAIN_MS = 120_000;

/**
 * The login Keychain through Security.framework (keychain-worker.ts), on a worker thread so a
 * macOS access prompt never stalls the host. Started on first use.
 */
export class KeychainBackend implements SecretBackend {
	private worker?: Worker;
	private next = 1;
	private pending = new Map<number, { resolve: (r: KeychainResponse) => void; timer: ReturnType<typeof setTimeout> }>();

	private call(request: KeychainRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never): Promise<KeychainResponse & { ok: true }> {
		if (!this.worker) {
			const url = URL.createObjectURL(new Blob([keychainWorker as unknown as string], { type: "application/typescript" }));
			const worker = new Worker(url);
			// It mustn't keep ToolBelt (or a test) running.
			(worker as unknown as { unref(): void }).unref();
			worker.onmessage = (event: MessageEvent<KeychainResponse>) => {
				const waiting = this.pending.get(event.data.id);
				if (!waiting) return;
				clearTimeout(waiting.timer);
				this.pending.delete(event.data.id);
				waiting.resolve(event.data);
			};
			worker.onerror = (event) => {
				for (const [id, waiting] of this.pending) {
					clearTimeout(waiting.timer);
					waiting.resolve({ id, ok: false, status: -1, error: `Keychain worker failed: ${event.message}` });
				}
				this.pending.clear();
				this.worker = undefined;
				worker.terminate();
			};
			this.worker = worker;
		}
		const id = this.next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("The Keychain didn't answer in time"));
			}, KEYCHAIN_MS);
			this.pending.set(id, {
				timer,
				resolve: (response) => (response.ok ? resolve(response) : reject(new Error(response.error))),
			});
			this.worker!.postMessage({ ...request, id } as KeychainRequest);
		});
	}
	async get(service: string, name: string) {
		return (await this.call({ op: "get", service, account: name })).value ?? null;
	}
	async set(service: string, name: string, value: string, label: string) {
		await this.call({ op: "set", service, account: name, value, label, kind: "ToolBelt plugin secret" });
	}
	async delete(service: string, name: string) {
		await this.call({ op: "delete", service, account: name });
	}
	async list(service: string) {
		return (await this.call({ op: "list", service })).names ?? [];
	}
}

/**
 * The Keychain service for a plugin's secrets: `ToolBelt:<repo>:<id>`, plus `:<profile>` outside
 * the official profile (`profile` is then a hash of the profile folder, see `profileKey`).
 */
export function secretService(pluginId: string, repo: string, profile: string | null) {
	return `ToolBelt:${repo.toLowerCase()}:${pluginId}${profile ? `:${profile}` : ""}`;
}

/** Null for the official profile; otherwise a short hash that keeps this profile's items apart. */
export function profileKey(profileRoot: string, officialRoot: string): string | null {
	return profileRoot === officialRoot ? null : createHash("sha256").update(profileRoot).digest("hex").slice(0, 12);
}

/** One plugin's secrets: its Keychain service, with the names it holds cached for the renderer. */
export class PluginSecrets {
	/** Names stored, once loaded (null until then, or when the backend couldn't list them). */
	private names: Set<string> | null = null;
	private loading?: Promise<void>;
	private listeners = new Set<() => void>();
	constructor(
		private readonly backend: SecretBackend,
		readonly service: string,
		private readonly pluginName: string,
		private readonly log: (line: string) => void,
	) {}

	/** Reads which names exist (once; again after a failure). */
	load(): Promise<void> {
		this.loading ??= this.backend.list(this.service).then(
			(names) => {
				this.names = new Set(names);
				this.emit();
			},
			(error) => {
				this.loading = undefined;
				this.log(`secrets: couldn't list the Keychain items: ${message(error)}`);
			},
		);
		return this.loading;
	}
	/** Whether a secret exists, as far as known now (false until loaded). */
	stored(name: string) {
		return this.names?.has(name) ?? false;
	}
	/** Called when the stored names change (to redraw which fields are saved). */
	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private emit() {
		for (const listener of this.listeners)
			try {
				listener();
			} catch {}
	}

	async get(name: string) {
		checkName(name);
		const value = await this.backend.get(this.service, name);
		await this.load();
		// Someone may have added or removed the item in Keychain Access.
		if (this.names && (value !== null) !== this.names.has(name)) {
			value === null ? this.names.delete(name) : this.names.add(name);
			this.emit();
		}
		return value;
	}
	async has(name: string) {
		checkName(name);
		await this.load();
		if (!this.names) return (await this.backend.get(this.service, name)) !== null;
		return this.names.has(name);
	}
	async set(name: string, value: string) {
		checkName(name);
		if (typeof value !== "string" || value === "") throw new Error("A secret's value can't be empty");
		if (Buffer.byteLength(value) > LIMITS.secretBytes) throw new Error(`A secret is at most ${LIMITS.secretBytes} bytes`);
		await this.load();
		if (this.names && !this.names.has(name) && this.names.size >= LIMITS.secrets) throw new Error(`A plugin keeps at most ${LIMITS.secrets} secrets`);
		await this.backend.set(this.service, name, value, `ToolBelt · ${this.pluginName} · ${name}`);
		if (this.names && !this.names.has(name)) {
			this.names.add(name);
			this.emit();
		}
	}
	async delete(name: string) {
		checkName(name);
		await this.backend.delete(this.service, name);
		if (this.names?.delete(name)) this.emit();
	}
	/** Deletes every secret this plugin has (removing it with its data). */
	async deleteAll() {
		const names = await this.backend.list(this.service);
		for (const name of names) await this.backend.delete(this.service, name);
		this.names = new Set();
		this.emit();
		return names.length;
	}
}

/** Every plugin's secrets in one profile: one `PluginSecrets` per service. */
export class SecretStore {
	private plugins = new Map<string, PluginSecrets>();
	constructor(
		readonly backend: SecretBackend,
		/** `profileKey(…)`: null for the official profile. */
		readonly profile: string | null,
		private readonly log: (line: string) => void = console.error,
	) {}
	forPlugin(plugin: { id: string; name: string; repo?: string }) {
		const service = secretService(plugin.id, plugin.repo ?? "local", this.profile);
		let secrets = this.plugins.get(service);
		if (!secrets) this.plugins.set(service, (secrets = new PluginSecrets(this.backend, service, plugin.name, (line) => this.log(`[${plugin.id}] ${line}`))));
		return secrets;
	}
	/** Deletes a plugin's secrets; failures are logged (without values) and don't throw. */
	async deleteAll(plugin: { id: string; name: string; repo?: string }) {
		try {
			const count = await this.forPlugin(plugin).deleteAll();
			if (count) this.log(`[${plugin.id}] secrets: deleted ${count} Keychain item${count === 1 ? "" : "s"}`);
		} catch (error) {
			this.log(`[${plugin.id}] secrets: couldn't delete the Keychain items: ${message(error)}`);
		}
	}
}

export function checkName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !SECRET_NAME.test(name)) throw new Error("A secret's name is 1–128 letters, digits and . _ / -");
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** An environment entry's secret: `<prefix>/<key>`, or null when the key can't name one (or has a `/`). */
export function entrySecret(prefix: string, key: string) {
	const name = `${prefix}/${key}`;
	return key && !key.includes("/") && SECRET_NAME.test(name) ? name : null;
}

// ── trees ─────────────────────────────────────────────────────────────────

type TextField = Extract<Field, { type: "text" }>;
type EnvironmentField = Extract<Field, { type: "environment" }>;
type Visit = (field: Field, form: string, rowId: string | undefined) => Field | void;

/**
 * Visits every form field in a tree, knowing its form and the row whose `pane` holds it, and
 * returns a copy with the fields `visit` replaced (the same tree when none was).
 */
function mapFields(tree: Node, visit: Visit): Node {
	const walk = (value: unknown, rowId: string | undefined): unknown => {
		if (Array.isArray(value)) {
			// Copied only when something in it changed.
			let next: unknown[] | undefined;
			for (let i = 0; i < value.length; i++) {
				const mapped = walk(value[i], rowId);
				if (mapped !== value[i]) (next ??= value.slice())[i] = mapped;
			}
			return next ?? value;
		}
		if (!value || typeof value !== "object") return value;
		const node = value as Record<string, unknown>;
		if (node.type === "form" && typeof node.id === "string" && Array.isArray(node.fields)) {
			let changed = false;
			const fields = (node.fields as Field[]).map((field) => {
				const mapped = visit(field, node.id as string, rowId);
				if (mapped && mapped !== field) {
					changed = true;
					return mapped;
				}
				return field;
			});
			return changed ? { ...node, fields } : value;
		}
		let next: Record<string, unknown> | undefined;
		for (const [key, child] of Object.entries(node)) {
			// A row's pane: its forms' events carry the row's id.
			const childRow = key === "pane" && typeof node.id === "string" ? (node.id as string) : rowId;
			const mapped = walk(child, childRow);
			if (mapped !== child) (next ??= { ...node })[key] = mapped;
		}
		return next ?? value;
	};
	return walk(tree, undefined) as Node;
}

/** The tree with `stored` set on secret fields and Keychain-backed environment entries. */
export function annotateSecrets(tree: Node, stored: (name: string) => boolean): Node {
	return mapFields(tree, (field) => {
		if (field.type === "text" && field.secret !== undefined) {
			const now = stored(field.secret);
			return field.stored === now ? field : { ...field, stored: now };
		}
		if (field.type === "environment" && field.secretPrefix !== undefined) {
			const prefix = field.secretPrefix;
			let changed = false;
			const value = field.value.map((entry) => {
				if (!entry.secret) return entry;
				const name = entrySecret(prefix, entry.key);
				const now = name ? stored(name) : false;
				if (entry.stored === now) return entry;
				changed = true;
				return { ...entry, stored: now };
			});
			return changed ? { ...field, value } : field;
		}
	});
}

/** The secret field or Keychain-backed environment field a `field` event is for, if it is one. */
export function findSecretField(tree: Node | null | undefined, form: string, fieldId: string, rowId: string | undefined): TextField | EnvironmentField | null {
	if (!tree) return null;
	let found: TextField | EnvironmentField | null = null;
	mapFields(tree, (field, formId, row) => {
		if (found || formId !== form || field.id !== fieldId || row !== rowId) return;
		if (field.type === "text" && field.secret !== undefined) found = field;
		else if (field.type === "environment" && field.secretPrefix !== undefined) found = field;
	});
	return found;
}

/**
 * What an environment field's committed entries do to its secrets: values to store, names to
 * delete (secret entries the field showed, `before`, that the person removed or renamed), and
 * the entries the plugin gets, without values. Entries whose key can't name a secret lose their
 * value. Only names the field itself showed are ever deleted.
 */
export function planEnvironment(prefix: string, entries: EnvironmentEntry[], before: EnvironmentEntry[]) {
	const writes: { name: string; value: string }[] = [];
	const kept = new Set<string>();
	const invalid: string[] = [];
	const forPlugin = entries.map((entry) => {
		if (!entry.secret) return { key: entry.key, value: entry.value, selected: entry.selected, secret: false };
		const name = entrySecret(prefix, entry.key);
		if (name) kept.add(name);
		if (entry.value !== "") {
			if (name) writes.push({ name, value: entry.value });
			else invalid.push(entry.key);
		}
		return { key: entry.key, value: "", selected: entry.selected, secret: true };
	});
	const shown = before.flatMap((entry) => {
		const name = entry.secret ? entrySecret(prefix, entry.key) : null;
		return name ? [name] : [];
	});
	return { writes, deletes: [...new Set(shown)].filter((name) => !kept.has(name)), invalid, entries: forPlugin };
}
