import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { inspectContainer, inspectImage, pullImage, listContainers } from '$lib/server/docker';
import { recreateContainer } from '$lib/server/scheduler/tasks/container-update';
import { isSystemContainer } from '$lib/server/scheduler/tasks/update-utils';
import { getPendingContainerUpdates, removePendingContainerUpdate, getStackSource } from '$lib/server/db';
import { applyServiceVersionBump } from '$lib/server/stacks';
import { repoBaseOf } from '$lib/utils/pinned-ref';
import type { ImageEnvLabels } from '$lib/server/container-env-merge';
import type { NewerVersion } from '$lib/types';

/**
 * POST /api/containers/{id}/apply-newer-version - Move a version-pinned container to
 * the newer version tag Dockhand's semver check already found for it.
 *
 * @openapi
 * summary: Apply a previously-detected newer version tag for a container - rewrites the tag in its stack's compose file (non-Git stacks only) and redeploys just that service via `docker compose up -d --no-deps`, or recreates the container directly when it isn't part of a stack (requires the 'create' permission, plus 'stacks'/'edit' when the container belongs to a stack)
 * description: Never trusts a client-supplied tag - looks up the newer-version suggestion Dockhand already recorded for this container (from a prior update check) and applies exactly that. Returns 400 if no suggestion is on record, and 409 if the container's stack is synced from Git (edit the compose file in the repository instead). The new image is pulled BEFORE the compose file is touched, so a bad/unpullable tag never leaves the compose file pointing at an image nothing runs; the stack is locked for the duration, same as a normal deploy. When the stack declares an `x-dockhand.update.cascade` policy, sibling services sharing the same image also move to the new tag (a system container or one labelled `dockhand.update=false`/`dockhand.hidden=true` is never swept in, even by `cascade: all`). Otherwise only this one container is touched.
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer! The target environment ID the container lives in (from GET /api/environments)
 * resp-200: {success:boolean!, tag:string!, imageBumpedServices:array<string>!, redeployServices:array<string>!, results:{}}
 * resp-200-example: {"success":true,"tag":"2026.5.3","imageBumpedServices":["server"],"redeployServices":["server"],"results":{"server":{"success":true,"detail":"updated to ghcr.io/goauthentik/server:2026.5.3"}}}
 * resp-400: No pending version-update suggestion on record for this container, or the compose file couldn't be safely edited (templated image, missing service, YAML error)
 * resp-403: Permission denied
 * resp-404: Container not found
 * resp-409: The container's stack is synced from Git - apply the tag change in the repository instead
 * resp-500: Failed to pull the new image, save the compose file, or redeploy the service
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('containers', 'create', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	if (!envIdNum) {
		return json({ error: 'env query parameter is required' }, { status: 400 });
	}

	try {
		const allContainers = await listContainers(true, envIdNum);
		const container = allContainers.find((c) => c.id === params.id || c.name === params.id);
		if (!container) {
			return json({ error: 'Container not found' }, { status: 404 });
		}

		const containerId = container.id;
		const containerName = container.name;
		const inspectData = (await inspectContainer(containerId, envIdNum)) as any;
		const currentImage: string = inspectData.Config?.Image;

		if (isSystemContainer(currentImage)) {
			return json({ error: 'Cannot update Dockhand or Hawser from within Dockhand' }, { status: 400 });
		}

		// Never trust a client-supplied tag - use the suggestion Dockhand already computed and recorded.
		const pending = await getPendingContainerUpdates(envIdNum);
		const row = pending.find((p) => p.containerId === containerId);
		if (!row?.newerVersion) {
			return json(
				{ error: 'No pending version update recorded for this container. Run a check for updates first.' },
				{ status: 400 }
			);
		}
		const newer = JSON.parse(row.newerVersion) as NewerVersion;

		const composeProject = container.labels?.['com.docker.compose.project'];
		const composeService = container.labels?.['com.docker.compose.service'] || containerName;

		if (composeProject) {
			// Writing a stack's compose file is a stack edit, same boundary as PUT
			// /api/stacks/{name}/compose - 'containers:create' alone isn't enough.
			if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
				return json({ error: 'Permission denied' }, { status: 403 });
			}

			const source = await getStackSource(composeProject, envIdNum);
			if (source?.sourceType === 'git') {
				return json(
					{
						error: `"${composeProject}" is synced from Git - update the tag in your repository, then sync and redeploy.`,
						gitSynced: true
					},
					{ status: 409 }
				);
			}

			const bump = await applyServiceVersionBump(composeProject, composeService, newer.tag, envIdNum);
			if (!bump.success && bump.error) {
				return json({ error: bump.error }, { status: bump.error.includes('not found') ? 404 : 400 });
			}

			// Audit and clear the pending-update flag per service, mirroring how
			// batch-update/batch-update-stream audit each container individually rather
			// than folding N recreated/restarted containers into one log entry.
			const updatedContainers = await listContainers(true, envIdNum);
			const bumpedSet = new Set(bump.imageBumpedServices);
			for (const svc of bump.redeployServices) {
				const outcome = bump.results[svc];
				if (!outcome) continue;
				const updated = updatedContainers.find(
					(c) =>
						c.labels?.['com.docker.compose.project'] === composeProject &&
						c.labels?.['com.docker.compose.service'] === svc
				);
				if (!updated) continue; // nothing to attribute the audit entry to
				if (outcome.success && bumpedSet.has(svc)) {
					await removePendingContainerUpdate(envIdNum, updated.id).catch(() => {});
				}
				await auditContainer(event, 'update', updated.id, updated.name, envIdNum, {
					newerVersionTag: newer.tag,
					bump: newer.bump,
					viaService: svc,
					cascade: !bumpedSet.has(svc),
					...outcome
				}).catch(() => {});
			}

			return json({
				success: bump.success,
				tag: newer.tag,
				imageBumpedServices: bump.imageBumpedServices,
				redeployServices: bump.redeployServices,
				results: bump.results
			});
		}

		// Standalone (non-compose) container: no compose file to touch, just pull +
		// recreate directly, the same way the rest of the app updates such containers.
		// A digest-pinned image is explicitly locked - same guard as the scheduled
		// auto-updater (isDigestBasedImage) - never silently drop the pin.
		if (currentImage.includes('@sha256:')) {
			return json({ error: `Image is pinned by digest (${currentImage}) - move the pin manually rather than have it silently dropped` }, { status: 400 });
		}
		const newFullRef = `${repoBaseOf(currentImage)}:${newer.tag}`;

		let oldImageConfig: ImageEnvLabels | null = null;
		try {
			const oldImg = (await inspectImage(inspectData.Image, envIdNum)) as any;
			oldImageConfig = {
				Env: oldImg?.Config?.Env,
				Labels: oldImg?.Config?.Labels,
				Cmd: oldImg?.Config?.Cmd ?? null,
				Entrypoint: oldImg?.Config?.Entrypoint ?? null
			};
		} catch {
			// best-effort; recreate falls back if unavailable
		}

		try {
			await pullImage(newFullRef, undefined, envIdNum);
		} catch (e: any) {
			return json({ error: `Failed to pull ${newFullRef}: ${e?.message || e}` }, { status: 500 });
		}

		const result = await recreateContainer(containerName, envIdNum, { imageNameOverride: newFullRef, oldImageConfig });

		// The container gets a NEW id on a successful recreate - re-resolve by NAME
		// (never by the pre-recreate id, which no longer refers to anything) before
		// clearing its pending-update row or writing the audit entry.
		let newContainerId = containerId;
		if (result.success) {
			const refreshed = (await listContainers(true, envIdNum)).find((c) => c.name === containerName);
			if (refreshed) newContainerId = refreshed.id;
			await removePendingContainerUpdate(envIdNum, newContainerId).catch(() => {});
		}

		await auditContainer(event, 'update', newContainerId, containerName, envIdNum, {
			newerVersionTag: newer.tag,
			bump: newer.bump,
			imageBumpedServices: [composeService],
			redeployServices: [composeService]
		});

		return json({
			success: result.success,
			tag: newer.tag,
			imageBumpedServices: [composeService],
			redeployServices: [composeService],
			results: { [composeService]: { success: result.success, detail: result.success ? `updated to ${newFullRef}` : result.error || 'update failed' } }
		});
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error applying newer-version update:', error?.message || error);
		return json({ error: 'Failed to apply version update', details: error?.message || String(error) }, { status: 500 });
	}
};
