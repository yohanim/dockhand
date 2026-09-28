/**
 * Applying a newer-version-tag suggestion to a compose file: rewriting the target
 * service's image tag while preserving everything else byte-for-byte, and working
 * out cascade targets from `x-dockhand.update`.
 */
import { describe, it, expect } from 'bun:test';
import { bumpServiceImageTag } from '../src/lib/server/semver/apply-tag';

describe('bumpServiceImageTag', () => {
	it('bumps only the target service by default (no cascade)', () => {
		const compose = `services:
  app:
    image: ghcr.io/goauthentik/server:2026.5.2
    restart: unless-stopped
  worker:
    image: ghcr.io/goauthentik/server:2026.5.2
  db:
    image: postgres:16
`;
		const result = bumpServiceImageTag(compose, 'app', '2026.5.3');
		expect('error' in result).toBe(false);
		if ('error' in result) return;

		expect(result.imageBumpedServices).toEqual(['app']);
		expect(result.redeployServices).toEqual(['app']);
		expect(result.imageRefs).toEqual({ app: 'ghcr.io/goauthentik/server:2026.5.3' });
		expect(result.content).toContain('image: ghcr.io/goauthentik/server:2026.5.3');
		// Sibling sharing the same image, and unrelated comments/formatting, untouched.
		expect(result.content).toContain('image: ghcr.io/goauthentik/server:2026.5.2');
		expect(result.content).toContain('restart: unless-stopped');
		expect(result.content).toContain('image: postgres:16');
	});

	it('finds a service defined after a column-0 divider comment inside services:', () => {
		const compose = `services:
  app:
    image: ghcr.io/goauthentik/server:2026.5.2

# --- workers ---
  worker:
    image: ghcr.io/goauthentik/server:2026.5.2
`;
		const result = bumpServiceImageTag(compose, 'worker', '2026.5.3');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.imageBumpedServices).toEqual(['worker']);
		expect(result.content).toContain('# --- workers ---');
		expect(result.content).toContain('image: ghcr.io/goauthentik/server:2026.5.3');
		expect(result.content).toContain('image: ghcr.io/goauthentik/server:2026.5.2'); // app untouched
	});

	it('cascades to same-image siblings when x-dockhand.update.cascade: same-image is set', () => {
		const compose = `x-dockhand:
  update:
    cascade: same-image
services:
  app:
    image: ghcr.io/goauthentik/server:2026.5.2
  worker:
    image: ghcr.io/goauthentik/server:2026.5.2
  db:
    image: postgres:16
`;
		const result = bumpServiceImageTag(compose, 'app', '2026.5.3');
		expect('error' in result).toBe(false);
		if ('error' in result) return;

		expect(result.imageBumpedServices.sort()).toEqual(['app', 'worker']);
		expect(result.redeployServices.sort()).toEqual(['app', 'worker']);
		expect(result.imageRefs).toEqual({
			app: 'ghcr.io/goauthentik/server:2026.5.3',
			worker: 'ghcr.io/goauthentik/server:2026.5.3'
		});
		expect((result.content.match(/2026\.5\.3/g) || []).length).toBe(2);
		expect(result.content).toContain('image: postgres:16');
	});

	it('redeploys the whole stack (minus exclude) on cascade: all, without touching unrelated images', () => {
		const compose = `x-dockhand:
  update:
    cascade: all
    exclude: [db]
services:
  app:
    image: ghcr.io/goauthentik/server:2026.5.2
  worker:
    image: ghcr.io/goauthentik/server:2026.5.2
  redis:
    image: redis:7
  db:
    image: postgres:16
`;
		const result = bumpServiceImageTag(compose, 'app', '2026.5.3');
		expect('error' in result).toBe(false);
		if ('error' in result) return;

		expect(result.imageBumpedServices.sort()).toEqual(['app', 'worker']);
		expect(result.redeployServices.sort()).toEqual(['app', 'redis', 'worker']);
		expect(result.content).toContain('image: redis:7');
		expect(result.content).toContain('image: postgres:16');
	});

	it('a per-service override wins over the stack default', () => {
		const compose = `x-dockhand:
  update:
    cascade: all
services:
  app:
    image: ghcr.io/goauthentik/server:2026.5.2
    x-dockhand:
      update:
        cascade: false
  worker:
    image: ghcr.io/goauthentik/server:2026.5.2
`;
		const result = bumpServiceImageTag(compose, 'app', '2026.5.3');
		expect('error' in result).toBe(false);
		if ('error' in result) return;

		expect(result.imageBumpedServices).toEqual(['app']);
		expect(result.redeployServices).toEqual(['app']);
	});

	it('errors on a missing service', () => {
		const compose = `services:\n  app:\n    image: nginx:1.25\n`;
		const result = bumpServiceImageTag(compose, 'ghost', '1.26');
		expect('error' in result).toBe(true);
	});

	it('errors on a build-only service with no image field', () => {
		const compose = `services:\n  app:\n    build: .\n`;
		const result = bumpServiceImageTag(compose, 'app', '1.0.0');
		expect('error' in result).toBe(true);
	});

	it('errors on a templated image tag', () => {
		const compose = `services:\n  app:\n    image: myrepo/app:\${APP_TAG}\n`;
		const result = bumpServiceImageTag(compose, 'app', '1.0.0');
		expect('error' in result).toBe(true);
	});

	it('refuses to bump a digest-pinned image rather than silently dropping the pin', () => {
		const compose = `services:\n  app:\n    image: nginx:1.25@sha256:abc123\n`;
		const result = bumpServiceImageTag(compose, 'app', '1.26');
		expect('error' in result).toBe(true);
	});

	it('never touches a nested "image:"-named key inside a command block scalar', () => {
		const compose = `services:
  app:
    command: |
      echo hello
      image: inner-not-a-key
      other: 1
    image: nginx:1.25
`;
		const result = bumpServiceImageTag(compose, 'app', '1.26');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.content).toContain('image: inner-not-a-key');
		expect(result.content).toContain('image: nginx:1.26');
	});

	it('normalizes a bare-scalar exclude (exclude: db) instead of dropping it', () => {
		const compose = `x-dockhand:
  update:
    cascade: all
    exclude: db
services:
  app:
    image: ghcr.io/x/app:1.0.0
  worker:
    image: ghcr.io/x/app:1.0.0
  db:
    image: postgres:16
`;
		const result = bumpServiceImageTag(compose, 'app', '1.1.0');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.redeployServices).not.toContain('db');
		expect(result.redeployServices).toContain('worker');
	});

	it('preserves each untouched line\'s own line ending in a mixed-EOL file', () => {
		const compose = 'services:\r\n  app:\r\n    image: nginx:1.25\n  db:\r\n    image: postgres:16\r\n';
		const result = bumpServiceImageTag(compose, 'app', '1.26');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.content).toContain('image: nginx:1.26\n  db:');
		expect(result.content).toContain('  app:\r\n');
	});

	it('preserves a tab-separated inline comment', () => {
		const compose = 'services:\n  app:\n    image: nginx:1.25\t# pinned\n';
		const result = bumpServiceImageTag(compose, 'app', '1.26');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.content).toContain('image: nginx:1.26\t# pinned');
	});

	it('drops a merge-key cascade sibling with no literal image: line instead of failing the whole plan', () => {
		const compose = `x-common: &common
  image: ghcr.io/x/app:1.0.0

x-dockhand:
  update:
    cascade: same-image

services:
  app:
    image: ghcr.io/x/app:1.0.0
  worker:
    <<: *common
`;
		const result = bumpServiceImageTag(compose, 'app', '1.1.0');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.imageBumpedServices).toEqual(['app']);
		expect(result.redeployServices).toEqual(['app']);
	});

	it('lets a caller protect a service via extraExclude regardless of the compose file\'s own policy', () => {
		const compose = `x-dockhand:
  update:
    cascade: all
services:
  app:
    image: ghcr.io/x/app:1.0.0
  system:
    image: fnsys/dockhand:latest
`;
		const result = bumpServiceImageTag(compose, 'app', '1.1.0', { extraExclude: ['system'] });
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.redeployServices).not.toContain('system');
	});

	it('refuses to silently drop a digest pin', () => {
		const compose = `services:\n  app:\n    image: ghcr.io/x/app:1.2@sha256:abcdef1234567890\n`;
		const result = bumpServiceImageTag(compose, 'app', '1.3');
		expect('error' in result).toBe(true);
	});

	it('same-image cascade requires an EXACT current-tag match, not just the same repo', () => {
		const compose = `x-dockhand:
  update:
    cascade: same-image
services:
  web:
    image: nginx:1.25
  proxy:
    image: nginx:1.25-alpine
`;
		const result = bumpServiceImageTag(compose, 'web', '1.26');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		// proxy is the same repo but a different tag/flavor - must NOT be swept in,
		// or its -alpine suffix would be destroyed and it'd jump onto a different base image.
		expect(result.imageBumpedServices).toEqual(['web']);
		expect(result.content).toContain('image: nginx:1.25-alpine');
	});

	it('same-image cascade does not jump a sibling deliberately held on an older major version', () => {
		const compose = `x-dockhand:
  update:
    cascade: same-image
services:
  db:
    image: postgres:16
  db-old:
    image: postgres:15
`;
		const result = bumpServiceImageTag(compose, 'db', '17');
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.imageBumpedServices).toEqual(['db']);
		expect(result.content).toContain('image: postgres:15');
	});
});
