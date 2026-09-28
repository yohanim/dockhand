/**
 * Apply a newer-version-tag suggestion (see `find-newer.ts`) to a compose file:
 * rewrite the target service's `image:` tag in place, and work out which OTHER
 * services (if any) should move with it per the stack's declared update policy.
 *
 * Structure (which service has which image, the x-dockhand policy) is read via
 * js-yaml. The edit itself is a surgical text replacement of just the `image:`
 * line(s), located via indentation - NOT a parse-then-dump round trip, since
 * js-yaml's dump() drops comments and can reformat/reorder the rest of the file.
 * Only the touched line(s) change; every other line - and every other line's
 * original line ending - is byte-for-byte untouched.
 */
import * as yaml from 'js-yaml';
import { repoBaseOf } from '../../utils/pinned-ref';

export interface CascadePlan {
	/** Services whose `image:` line is rewritten to the new tag (always includes the primary service). */
	imageBumpedServices: string[];
	/** Services to redeploy - a superset of imageBumpedServices per the stack's x-dockhand.update.cascade policy. */
	redeployServices: string[];
	/**
	 * The exact `repo:tag` each bumped service was rewritten to, keyed by service name -
	 * derived from the COMPOSE FILE's declared image (not the running container's, which
	 * may have drifted from it). The caller MUST reuse these when pulling/recreating, so
	 * the container that gets deployed always matches what was just written to disk.
	 */
	imageRefs: Record<string, string>;
}

export type BumpOutcome = ({ content: string } & CascadePlan) | { error: string };

export interface BumpOptions {
	/**
	 * Service names to treat as excluded regardless of the compose file's own
	 * `x-dockhand.update.exclude` - for callers that need to protect a service
	 * (e.g. a system container swept in by a same-image/all cascade) the compose
	 * author never listed.
	 */
	extraExclude?: string[];
}

interface UpdatePolicy {
	cascade: 'same-image' | 'all' | false;
	exclude: string[];
}

/** A bare scalar (`exclude: db`) is the natural way to write ONE exclusion - normalize it to `[db]` rather than silently dropping it. */
function normalizeStringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return [];
}

/** Reads `x-dockhand.update` from a parsed value; a per-service block wins over the stack default. */
function readUpdatePolicy(stackXDockhand: unknown, serviceXDockhand: unknown): UpdatePolicy {
	const stack = (stackXDockhand as { update?: { cascade?: unknown; exclude?: unknown } } | undefined)?.update ?? {};
	const service = (serviceXDockhand as { update?: { cascade?: unknown; exclude?: unknown } } | undefined)?.update ?? {};
	const cascadeRaw = service.cascade ?? stack.cascade ?? false;
	const cascade = cascadeRaw === 'same-image' || cascadeRaw === 'all' ? cascadeRaw : false;
	const exclude = 'exclude' in service ? normalizeStringList(service.exclude) : normalizeStringList(stack.exclude);
	return { cascade, exclude };
}

/** True when an image reference embeds a `${VAR}`/`$VAR` interpolation - not a literal tag we can bump. */
function isTemplatedImage(image: string): boolean {
	return /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(image);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One line of the original file: its text (no terminator) and its ORIGINAL terminator, preserved verbatim. */
interface Line {
	text: string;
	/** '\n', '\r\n', or '' for a final line with no trailing newline. */
	term: string;
}

function splitLinesPreservingEol(content: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] !== '\n') continue;
		const crlf = i > start && content[i - 1] === '\r';
		lines.push({ text: content.slice(start, crlf ? i - 1 : i), term: crlf ? '\r\n' : '\n' });
		start = i + 1;
	}
	if (start < content.length || content.length === 0) {
		lines.push({ text: content.slice(start), term: '' });
	}
	return lines;
}

function joinLines(lines: Line[]): string {
	return lines.map((l) => l.text + l.term).join('');
}

/** Column of the first indented, non-blank, non-comment line after `headerLine` and before `boundLine`, or -1. */
function firstChildIndent(lines: string[], headerLine: number, boundLine: number): number {
	for (let i = headerLine + 1; i < boundLine; i++) {
		const line = lines[i];
		if (!line.trim() || /^\s*#/.test(line)) continue;
		return /^(\s*)/.exec(line)![1].length;
	}
	return -1;
}

/** The (start, end) line range of a top-level (column-0) `key:` block. */
function topLevelKeyBlock(lines: string[], key: string): { headerLine: number; childIndent: number; endLine: number } | null {
	const keyRe = new RegExp(`^${escapeRegex(key)}:\\s*(#.*)?$`);
	const headerLine = lines.findIndex((l) => keyRe.test(l));
	if (headerLine === -1) return null;

	let endLine = lines.length;
	for (let i = headerLine + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim() || /^\s*#/.test(line)) continue;
		if (/^(\s*)/.exec(line)![1].length === 0) { endLine = i; break; }
	}

	const childIndent = firstChildIndent(lines, headerLine, endLine);
	if (childIndent <= 0) return null;

	return { headerLine, childIndent, endLine };
}

/** The (start, end) line range of one service's mapping inside the `services:` block. */
function serviceBlock(
	lines: string[],
	services: { headerLine: number; childIndent: number; endLine: number },
	serviceName: string
): { start: number; end: number } | null {
	const indent = ' '.repeat(services.childIndent);
	const escaped = escapeRegex(serviceName);
	const nameRe = new RegExp(`^${indent}(?:${escaped}|['"]${escaped}['"]):\\s*(#.*)?$`);

	let start = -1;
	for (let i = services.headerLine + 1; i < services.endLine; i++) {
		if (nameRe.test(lines[i])) { start = i; break; }
	}
	if (start === -1) return null;

	let end = services.endLine;
	for (let i = start + 1; i < services.endLine; i++) {
		const line = lines[i];
		if (!line.trim() || /^\s*#/.test(line)) continue;
		if (/^(\s*)/.exec(line)![1].length <= services.childIndent) { end = i; break; }
	}
	return { start, end };
}

interface ParsedImageLine {
	indent: string;
	quote: '"' | "'" | null;
	/** Everything after the value: an inline comment (with its leading whitespace), or ''. */
	trailing: string;
}

function parseImageLine(line: string): ParsedImageLine | null {
	const m = /^(\s*)image:\s*(.*)$/.exec(line);
	if (!m) return null;
	const indent = m[1];
	const rest = m[2];

	if (rest[0] === '"' || rest[0] === "'") {
		const q = rest[0] as '"' | "'";
		const endIdx = rest.indexOf(q, 1);
		if (endIdx !== -1) {
			return { indent, quote: q, trailing: rest.slice(endIdx + 1) };
		}
	}

	// Unquoted: a real image reference never contains '#', so anything from the
	// first one onward (kept with whatever whitespace precedes it) is an inline comment.
	const hashIdx = rest.search(/(?:^|\s)#/);
	if (hashIdx === -1) return { indent, quote: null, trailing: '' };
	return { indent, quote: null, trailing: rest.slice(hashIdx) };
}

/** Finds the service's OWN `image:` property line - at the service's direct-property
 *  indentation only, never a nested `image:`-named key inside a `command: |` block
 *  scalar, a `labels` map, `build.args`, etc. */
function findOwnImageLine(lines: string[], block: { start: number; end: number }): number | null {
	const propIndent = firstChildIndent(lines, block.start, block.end);
	if (propIndent < 0) return null;
	for (let i = block.start + 1; i < block.end; i++) {
		const imageLine = parseImageLine(lines[i]);
		if (!imageLine) continue;
		if (imageLine.indent.length !== propIndent) continue;
		return i;
	}
	return null;
}

function renderImageLine(parsed: ParsedImageLine, newValue: string): string {
	const value = parsed.quote ? `${parsed.quote}${newValue}${parsed.quote}` : newValue;
	return `${parsed.indent}image: ${value}${parsed.trailing}`;
}

/**
 * Rewrite `services.<serviceName>.image`'s tag to `newTag`. Returns the updated
 * compose content plus which services had their image bumped and which should be
 * redeployed. Default policy (no `x-dockhand.update.cascade` set) touches only
 * `serviceName` itself.
 */
export function bumpServiceImageTag(
	composeContent: string,
	serviceName: string,
	newTag: string,
	options: BumpOptions = {}
): BumpOutcome {
	let parsed: any;
	try {
		parsed = yaml.load(composeContent);
	} catch (e: any) {
		return { error: `Failed to parse compose file: ${e?.message || e}` };
	}

	const services = parsed?.services;
	if (!services || typeof services !== 'object') {
		return { error: 'No services block found in compose file' };
	}

	const target = services[serviceName];
	if (!target) {
		return { error: `Service "${serviceName}" not found in compose file` };
	}

	const currentImage = target.image;
	if (typeof currentImage !== 'string' || !currentImage.trim()) {
		return { error: `Service "${serviceName}" has no "image:" field to update (build-only service?)` };
	}
	if (isTemplatedImage(currentImage)) {
		return { error: `Service "${serviceName}" image is set via a variable ("${currentImage}") - edit that variable instead` };
	}
	// A digest-pinned image (`repo:tag@sha256:...`) is explicitly locked to a specific
	// build, same guard as the scheduled auto-updater (container-update.ts:isDigestBasedImage) -
	// silently dropping the pin to follow a mutable tag would undo that on purpose.
	if (currentImage.includes('@sha256:')) {
		return { error: `Service "${serviceName}" image is pinned by digest (${currentImage}) - move the pin manually rather than have it silently dropped` };
	}

	const repo = repoBaseOf(currentImage);
	const newFullRef = `${repo}:${newTag}`;

	const policy = readUpdatePolicy(parsed?.['x-dockhand'], target['x-dockhand']);
	const exclude = new Set([...policy.exclude, ...(options.extraExclude ?? [])]);

	const imageBumpCandidates = new Set<string>([serviceName]);
	const redeploy = new Set<string>([serviceName]);

	if (policy.cascade === 'same-image' || policy.cascade === 'all') {
		// Exact match on the FULL current image (repo AND tag) - not just the repo.
		// Matching on repo alone would also catch a sibling on a different flavor or
		// version (nginx:1.25 vs nginx:1.25-alpine, postgres:15 vs postgres:16) and
		// silently rewrite it onto the primary's tag, destroying its flavor suffix or
		// jumping it across a major version it was deliberately held back on. A
		// same-image cascade is only safe for a sibling that's pinned to the exact
		// same starting reference as the primary.
		for (const [name, svc] of Object.entries(services as Record<string, any>)) {
			if (name === serviceName || exclude.has(name)) continue;
			const img = typeof svc?.image === 'string' ? svc.image : null;
			if (img && img === currentImage) {
				imageBumpCandidates.add(name);
				redeploy.add(name);
			}
		}
	}
	if (policy.cascade === 'all') {
		for (const name of Object.keys(services)) {
			if (!exclude.has(name)) redeploy.add(name);
		}
	}

	const lineRecords = splitLinesPreservingEol(composeContent);
	const lines = lineRecords.map((l) => l.text);

	const servicesBlock = topLevelKeyBlock(lines, 'services');
	if (!servicesBlock) {
		return { error: 'Could not locate a block-style "services:" section to edit' };
	}

	const imageBumped = new Set<string>();
	for (const name of imageBumpCandidates) {
		const block = serviceBlock(lines, servicesBlock, name);
		if (!block) {
			return { error: `Could not locate service "${name}" in the compose file text` };
		}
		const lineIdx = findOwnImageLine(lines, block);
		if (lineIdx === null) {
			if (name === serviceName) {
				return { error: `Could not locate the "image:" line for service "${name}"` };
			}
			// A cascade sibling whose image comes only from a YAML merge key/anchor has
			// no literal line of its own to rewrite here - drop it rather than fail the
			// whole plan over a service the user didn't ask to update.
			redeploy.delete(name);
			continue;
		}
		const rendered = renderImageLine(parseImageLine(lines[lineIdx])!, newFullRef);
		lineRecords[lineIdx] = { ...lineRecords[lineIdx], text: rendered };
		imageBumped.add(name);
	}

	return {
		content: joinLines(lineRecords),
		imageBumpedServices: [...imageBumped],
		redeployServices: [...redeploy],
		imageRefs: Object.fromEntries([...imageBumped].map((name) => [name, newFullRef]))
	};
}
