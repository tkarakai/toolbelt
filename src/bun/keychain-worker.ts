// The macOS login Keychain through Security.framework, called with bun:ffi on a worker thread
// (`KeychainBackend` in secrets.ts starts it from this file's text). Keychain calls can wait for
// the person to answer a macOS access prompt; on this thread that never stalls the host.
//
// Items are generic passwords: service (one per plugin and profile), account (the secret's
// name), label (what Keychain Access shows) and the value as data. Values go in and out as
// CFData built from bytes; no value is ever passed on a command line.
import { dlopen, FFIType, ptr, read, toArrayBuffer } from "bun:ffi";

export type KeychainRequest =
	| { id: number; op: "get"; service: string; account: string }
	| { id: number; op: "set"; service: string; account: string; value: string; label: string; kind: string }
	| { id: number; op: "delete"; service: string; account: string }
	| { id: number; op: "list"; service: string };
export type KeychainResponse = { id: number; ok: true; value?: string | null; names?: string[] } | { id: number; ok: false; status: number; error: string };

const { i32, i64, u64, ptr: P, bool } = FFIType;
const system = dlopen("/usr/lib/libSystem.B.dylib", { dlsym: { args: [i64, P], returns: P } });
const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
	CFStringCreateWithBytes: { args: [P, P, i64, u64, bool], returns: P },
	CFStringGetLength: { args: [P], returns: i64 },
	CFStringGetMaximumSizeForEncoding: { args: [i64, u64], returns: i64 },
	CFStringGetCString: { args: [P, P, i64, u64], returns: bool },
	CFDataCreate: { args: [P, P, i64], returns: P },
	CFDataGetLength: { args: [P], returns: i64 },
	CFDataGetBytePtr: { args: [P], returns: P },
	CFDictionaryCreate: { args: [P, P, P, i64, P, P], returns: P },
	CFDictionaryGetValue: { args: [P, P], returns: P },
	CFArrayGetCount: { args: [P], returns: i64 },
	CFArrayGetValueAtIndex: { args: [P, i64], returns: P },
	CFGetTypeID: { args: [P], returns: u64 },
	CFArrayGetTypeID: { args: [], returns: u64 },
	CFRelease: { args: [P], returns: FFIType.void },
});
const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
	SecItemAdd: { args: [P, P], returns: i32 },
	SecItemCopyMatching: { args: [P, P], returns: i32 },
	SecItemUpdate: { args: [P, P], returns: i32 },
	SecItemDelete: { args: [P], returns: i32 },
	SecCopyErrorMessageString: { args: [i32, P], returns: P },
});

const UTF8 = 0x08000100; // kCFStringEncodingUTF8
const RTLD_DEFAULT = -2;
const NOT_FOUND = -25300; // errSecItemNotFound
type Ref = NonNullable<ReturnType<typeof cf.symbols.CFDataCreate>>;

/** The address of a framework's exported symbol (constants are data, not functions). */
function address(name: string): Ref {
	const at = system.symbols.dlsym(RTLD_DEFAULT, ptr(Buffer.from(`${name}\0`)));
	if (!at) throw new Error(`Security.framework has no ${name}`);
	return at;
}
/** The CFTypeRef an exported constant (kSecClass, kCFBooleanTrue…) holds. */
const constant = (name: string) => read.ptr(address(name)) as Ref;
const K = {
	class: constant("kSecClass"),
	genericPassword: constant("kSecClassGenericPassword"),
	service: constant("kSecAttrService"),
	account: constant("kSecAttrAccount"),
	label: constant("kSecAttrLabel"),
	kind: constant("kSecAttrDescription"),
	data: constant("kSecValueData"),
	returnData: constant("kSecReturnData"),
	returnAttributes: constant("kSecReturnAttributes"),
	matchLimit: constant("kSecMatchLimit"),
	one: constant("kSecMatchLimitOne"),
	all: constant("kSecMatchLimitAll"),
	yes: constant("kCFBooleanTrue"),
};
const keyCallbacks = address("kCFTypeDictionaryKeyCallBacks");
const valueCallbacks = address("kCFTypeDictionaryValueCallBacks");

/** Creates CF objects and releases them all when the request is done. */
class Scope {
	private refs: Ref[] = [];
	own<T extends Ref | null>(ref: T): T {
		if (ref) this.refs.push(ref);
		return ref;
	}
	string(text: string) {
		const bytes = Buffer.from(text, "utf8");
		const ref = this.own(cf.symbols.CFStringCreateWithBytes(null, bytes.length ? ptr(bytes) : null, bytes.length, UTF8, false));
		if (!ref) throw new Error("Couldn't create a string");
		return ref;
	}
	data(text: string) {
		const bytes = Buffer.from(text, "utf8");
		const ref = this.own(cf.symbols.CFDataCreate(null, ptr(bytes), bytes.length));
		bytes.fill(0);
		if (!ref) throw new Error("Couldn't create data");
		return ref;
	}
	dictionary(entries: [Ref, Ref][]) {
		const keys = new BigUint64Array(entries.map(([k]) => BigInt(k as number)));
		const values = new BigUint64Array(entries.map(([, v]) => BigInt(v as number)));
		const ref = this.own(cf.symbols.CFDictionaryCreate(null, ptr(keys), ptr(values), entries.length, keyCallbacks, valueCallbacks));
		if (!ref) throw new Error("Couldn't create a dictionary");
		return ref;
	}
	release() {
		for (const ref of this.refs.reverse()) cf.symbols.CFRelease(ref);
		this.refs = [];
	}
}

function stringValue(ref: Ref | null): string | null {
	if (!ref) return null;
	const size = Number(cf.symbols.CFStringGetMaximumSizeForEncoding(cf.symbols.CFStringGetLength(ref), UTF8)) + 1;
	const buffer = Buffer.alloc(size);
	return cf.symbols.CFStringGetCString(ref, ptr(buffer), size, UTF8) ? buffer.toString("utf8", 0, buffer.indexOf(0)) : null;
}

class KeychainError extends Error {
	constructor(readonly status: number, what: string) {
		const scope = new Scope();
		const detail = stringValue(scope.own(sec.symbols.SecCopyErrorMessageString(status, null)));
		scope.release();
		super(`${what}: ${detail ?? "Keychain error"} (${status})`);
	}
}

function item(scope: Scope, service: string, account?: string): [Ref, Ref][] {
	return [[K.class, K.genericPassword], [K.service, scope.string(service)], ...(account === undefined ? [] : ([[K.account, scope.string(account)]] as [Ref, Ref][]))];
}

function get(service: string, account: string): string | null {
	const scope = new Scope();
	try {
		const out = new BigUint64Array(1);
		const status = sec.symbols.SecItemCopyMatching(scope.dictionary([...item(scope, service, account), [K.returnData, K.yes], [K.matchLimit, K.one]]), ptr(out));
		if (status === NOT_FOUND) return null;
		if (status !== 0) throw new KeychainError(status, "Couldn't read from the Keychain");
		const data = scope.own(Number(out[0]) as Ref);
		const length = Number(cf.symbols.CFDataGetLength(data));
		if (!length) return "";
		const bytes = Buffer.from(toArrayBuffer(cf.symbols.CFDataGetBytePtr(data)!, 0, length));
		const value = bytes.toString("utf8");
		bytes.fill(0);
		return value;
	} finally {
		scope.release();
	}
}

function set(service: string, account: string, value: string, label: string, kind: string) {
	const scope = new Scope();
	try {
		const query = scope.dictionary(item(scope, service, account));
		const changes = scope.dictionary([[K.data, scope.data(value)], [K.label, scope.string(label)]]);
		let status = sec.symbols.SecItemUpdate(query, changes);
		if (status === NOT_FOUND)
			status = sec.symbols.SecItemAdd(scope.dictionary([...item(scope, service, account), [K.label, scope.string(label)], [K.kind, scope.string(kind)], [K.data, scope.data(value)]]), null);
		if (status !== 0) throw new KeychainError(status, "Couldn't save to the Keychain");
	} finally {
		scope.release();
	}
}

function remove(service: string, account: string) {
	const scope = new Scope();
	try {
		const status = sec.symbols.SecItemDelete(scope.dictionary(item(scope, service, account)));
		if (status !== 0 && status !== NOT_FOUND) throw new KeychainError(status, "Couldn't delete from the Keychain");
	} finally {
		scope.release();
	}
}

/** The accounts (secret names) under a service. Reads attributes only, never values. */
function list(service: string): string[] {
	const scope = new Scope();
	try {
		const out = new BigUint64Array(1);
		const status = sec.symbols.SecItemCopyMatching(scope.dictionary([...item(scope, service), [K.returnAttributes, K.yes], [K.matchLimit, K.all]]), ptr(out));
		if (status === NOT_FOUND) return [];
		if (status !== 0) throw new KeychainError(status, "Couldn't list Keychain items");
		const result = scope.own(Number(out[0]) as Ref);
		const items = cf.symbols.CFGetTypeID(result) === cf.symbols.CFArrayGetTypeID() ? Array.from({ length: Number(cf.symbols.CFArrayGetCount(result)) }, (_, i) => cf.symbols.CFArrayGetValueAtIndex(result, i)!) : [result];
		return items.flatMap((attributes) => {
			const name = stringValue(cf.symbols.CFDictionaryGetValue(attributes, K.account));
			return name === null ? [] : [name];
		});
	} finally {
		scope.release();
	}
}

export function handle(request: KeychainRequest): KeychainResponse {
	try {
		switch (request.op) {
			case "get":
				return { id: request.id, ok: true, value: get(request.service, request.account) };
			case "set":
				set(request.service, request.account, request.value, request.label, request.kind);
				return { id: request.id, ok: true };
			case "delete":
				remove(request.service, request.account);
				return { id: request.id, ok: true };
			case "list":
				return { id: request.id, ok: true, names: list(request.service) };
		}
	} catch (error) {
		return { id: request.id, ok: false, status: error instanceof KeychainError ? error.status : -1, error: error instanceof Error ? error.message : String(error) };
	}
}

// As a worker: answer requests in order. Imported (tests, type checks), it only exports.
if (!Bun.isMainThread) {
	const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<KeychainRequest>) => void) | null; postMessage(message: KeychainResponse): void };
	scope.onmessage = (event) => scope.postMessage(handle(event.data));
}
