import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const MILESTONE = 'M113';
const SCENARIO_FILE = 'fixtures/integration/m113_scenario.json';
const EXPECTED_FILE = 'fixtures/integration/m113_expected.json';
const OUTPUT_FILE = 'render_smoke_hardening_output.json';

if (process.env.INTEGRATION_ENABLED !== '1') {
  throw new Error('M113 integration gate requires INTEGRATION_ENABLED=1');
}

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function trimOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildUrl(base, pathname, query = {}) {
  const baseUrl = new URL(base.endsWith('/') ? base : `${base}/`);
  const relativePath = String(pathname ?? '').replace(/^\/+/, '');
  const url = new URL(relativePath, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      url.searchParams.set(key, value.join(','));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function requireEnv(name) {
  const value = trimOrNull(process.env[name]);
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

function cleanObject(value) {
  if (Array.isArray(value)) {
    return value.map(cleanObject);
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = cleanObject(v);
  }
  return out;
}

function idempotencyKey(prefix, index) {
  return `${prefix}-${Date.now()}-${index}`;
}

function transientNetworkCode(error) {
  return trimOrNull(
    error?.code ??
    error?.cause?.code ??
    null
  );
}

function isTransientNetworkError(error) {
  if (String(error?.name ?? '') === 'AbortError') return true;
  const code = String(transientNetworkCode(error) ?? '').toUpperCase();
  if (!code) return false;
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT'
  ].includes(code);
}

function isRetriableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

async function retryDelay(attempt) {
  const base = Number.parseInt(trimOrNull(process.env.RENDER_HTTP_RETRY_DELAY_MS) ?? '1000', 10);
  const baseMs = Number.isFinite(base) && base >= 100 ? base : 1000;
  const jitter = Math.floor(Math.random() * 250);
  const backoff = Math.min(8000, baseMs * (2 ** attempt));
  await sleep(backoff + jitter);
}

async function httpJson({ url, method = 'GET', headers = {}, body, okStatuses = [200] }) {
  const configuredAttempts = Number.parseInt(trimOrNull(process.env.RENDER_HTTP_RETRIES) ?? '4', 10);
  const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1 ? configuredAttempts : 4;
  const configuredTimeoutMs = Number.parseInt(trimOrNull(process.env.RENDER_HTTP_TIMEOUT_MS) ?? '20000', 10);
  const requestTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 1000 ? configuredTimeoutMs : 20000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response = null;
      try {
        response = await fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            ...headers
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text };
      }

      if (!okStatuses.includes(response.status)) {
        const error = new Error(`http request failed: ${method} ${url} -> ${response.status}`);
        error.status = response.status;
        error.body = parsed;
        if (attempt + 1 < attempts && isRetriableStatus(response.status)) {
          await retryDelay(attempt);
          continue;
        }
        throw error;
      }

      return {
        status: response.status,
        body: parsed
      };
    } catch (error) {
      if (attempt + 1 < attempts && isTransientNetworkError(error)) {
        await retryDelay(attempt);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`http request exhausted retries: ${method} ${url}`);
}

function renderHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  };
}

function normalizeService(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload?.id ? payload : null;
  const service = payload?.service && typeof payload.service === 'object' ? payload.service : null;
  const dataService = payload?.data?.service && typeof payload.data.service === 'object' ? payload.data.service : null;
  const resultService = payload?.result?.service && typeof payload.result.service === 'object' ? payload.result.service : null;
  const data = payload?.data?.id ? payload.data : null;
  const result = payload?.result?.id ? payload.result : null;
  return service ?? dataService ?? resultService ?? direct ?? data ?? result;
}

function normalizeServicesListPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.services)) return payload.services;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

function normalizeDeploy(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload?.id ? payload : null;
  const deploy = payload?.deploy && typeof payload.deploy === 'object' ? payload.deploy : null;
  const dataDeploy = payload?.data?.deploy && typeof payload.data.deploy === 'object' ? payload.data.deploy : null;
  const resultDeploy = payload?.result?.deploy && typeof payload.result.deploy === 'object' ? payload.result.deploy : null;
  const data = payload?.data?.id ? payload.data : null;
  const result = payload?.result?.id ? payload.result : null;
  return deploy ?? dataDeploy ?? resultDeploy ?? direct ?? data ?? result;
}

function normalizeDeployListPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.deploys)) return payload.deploys;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

function toServiceRows(payload) {
  const list = normalizeServicesListPayload(payload);
  return list
    .map(item => ({
      service: normalizeService(item),
      cursor: item?.cursor ?? null
    }))
    .filter(item => !!item.service?.id);
}

function toOwnerRows(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.owners)
      ? payload.owners
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.result)
          ? payload.result
          : [];

  if (list.length > 0) {
    return list
      .map(item => {
        const owner = item?.owner && typeof item.owner === 'object' ? item.owner : item;
        const cursor = item?.cursor ?? null;
        return owner?.id ? { owner, cursor } : null;
      })
      .filter(Boolean);
  }
  if (payload?.owner?.id) {
    return [{ owner: payload.owner, cursor: payload?.cursor ?? null }];
  }
  if (payload?.id) {
    return [{ owner: payload, cursor: payload?.cursor ?? null }];
  }
  return [];
}

function ownerIdFromService(service) {
  return trimOrNull(service?.ownerId ?? service?.owner?.id ?? null);
}

function ownerIdentity(owner) {
  return [
    trimOrNull(owner?.name),
    trimOrNull(owner?.slug),
    trimOrNull(owner?.email),
    trimOrNull(owner?.id)
  ]
    .filter(Boolean)
    .join(' / ');
}

function currentDeployStatus(payload) {
  return trimOrNull(normalizeDeploy(payload)?.status ?? null);
}

function renderErrorMessage(error) {
  return trimOrNull(
    error?.body?.message ??
    error?.body?.raw ??
    error?.message ??
    null
  ) ?? 'unknown render error';
}

function isPendingDeployStatus(status) {
  return [
    'created',
    'queued',
    'build_in_progress',
    'update_in_progress',
    'pre_deploy_in_progress',
    'cancelling'
  ].includes(String(status ?? '').toLowerCase());
}

function smokeHeaders({ actorType, actorId, scopes, idempotency }) {
  const headers = {
    'content-type': 'application/json',
    'x-actor-type': actorType,
    'x-actor-id': actorId,
    'x-auth-scopes': scopes.join(' ')
  };
  if (idempotency) headers['idempotency-key'] = idempotency;
  return headers;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

const renderApiKey = requireEnv('RENDER_API_KEY');
const renderApiBase = trimOrNull(process.env.RENDER_API_BASE) ?? 'https://api.render.com/v1';
const renderOwnerIdHint = trimOrNull(process.env.RENDER_OWNER_ID);
const renderOwnerNameHint = trimOrNull(process.env.RENDER_OWNER_NAME);
const renderServiceIdHint = trimOrNull(process.env.RENDER_SERVICE_ID);
const renderServiceName = trimOrNull(process.env.RENDER_SERVICE_NAME) ?? trimOrNull(scenario?.service?.name) ?? 'swapgraph-runtime-api';
const renderServiceType = trimOrNull(process.env.RENDER_SERVICE_TYPE) ?? trimOrNull(scenario?.service?.type) ?? 'web_service';
const renderRepo = trimOrNull(process.env.RENDER_REPO_URL);
const renderBranch = trimOrNull(process.env.RENDER_REPO_BRANCH) ?? 'main';
const renderRootDir = process.env.RENDER_ROOT_DIR ?? '';
const renderRegion = trimOrNull(process.env.RENDER_REGION) ?? 'oregon';
const renderPlan = trimOrNull(process.env.RENDER_PLAN) ?? 'starter';
const renderRuntime = trimOrNull(process.env.RENDER_RUNTIME) ?? 'node';
const renderBuildCommand = trimOrNull(process.env.RENDER_BUILD_COMMAND) ?? 'npm ci';
const renderStartCommand = trimOrNull(process.env.RENDER_START_COMMAND) ?? 'node scripts/run-api-server.mjs';
const renderAutoDeploy = trimOrNull(process.env.RENDER_AUTO_DEPLOY) ?? 'yes';

const renderDiskName = trimOrNull(process.env.RENDER_DISK_NAME) ?? 'swapgraph-state';
const renderDiskMountPath = trimOrNull(process.env.RENDER_DISK_MOUNT_PATH) ?? '/var/data';
const renderDiskSizeGb = Number.parseInt(trimOrNull(process.env.RENDER_DISK_SIZE_GB) ?? '1', 10);
if (!Number.isFinite(renderDiskSizeGb) || renderDiskSizeGb < 1) throw new Error('RENDER_DISK_SIZE_GB must be an integer >= 1');

const stateFileName = trimOrNull(process.env.RENDER_STATE_FILE_NAME) ?? trimOrNull(scenario?.state_file_name) ?? 'runtime-api-state.sqlite';
const stateFilePath = trimOrNull(process.env.RENDER_STATE_FILE) ?? `${renderDiskMountPath.replace(/\/+$/g, '')}/${stateFileName}`;

const deployTimeoutSeconds = Number.parseInt(trimOrNull(process.env.RENDER_DEPLOY_WAIT_SECONDS) ?? '900', 10);
const deployPollSeconds = Number.parseInt(trimOrNull(process.env.RENDER_DEPLOY_POLL_SECONDS) ?? '10', 10);
if (!Number.isFinite(deployTimeoutSeconds) || deployTimeoutSeconds < 30) throw new Error('RENDER_DEPLOY_WAIT_SECONDS must be >= 30');
if (!Number.isFinite(deployPollSeconds) || deployPollSeconds < 2) throw new Error('RENDER_DEPLOY_POLL_SECONDS must be >= 2');

const healthPath = trimOrNull(process.env.SMOKE_HEALTH_PATH) ?? trimOrNull(scenario?.health_path) ?? '/healthz';

const smokeUserActor = scenario?.smoke?.user_actor;
const smokePartnerActor = scenario?.smoke?.partner_actor;
const smokeIntents = Array.isArray(scenario?.smoke?.intents) ? scenario.smoke.intents : [];
const smokeMatchingRequest = scenario?.smoke?.matching_request ?? {};

if (!smokeUserActor?.id || smokeUserActor?.type !== 'user') throw new Error('scenario.smoke.user_actor must be a user actor');
if (!smokePartnerActor?.id || smokePartnerActor?.type !== 'partner') throw new Error('scenario.smoke.partner_actor must be a partner actor');
if (smokeIntents.length < 2) throw new Error('scenario.smoke.intents must include at least two intents');

const expectedHealthBackend = expected?.expected?.health?.store_backend ?? 'sqlite';
const expectedHealthMode = expected?.expected?.health?.persistence_mode ?? 'sqlite_wal';
const minIntentsAfterCreate = Number(expected?.expected?.smoke?.min_intents_after_create ?? 2);
const minIntentsAfterRestart = Number(expected?.expected?.smoke?.min_intents_after_restart ?? 2);

const operations = [];
const deployStatusTrail = [];
const renderAuthHeaders = renderHeaders(renderApiKey);
let resolvedRenderOwnerId = renderOwnerIdHint;

async function renderRequest({ method, pathname, query, body, okStatuses }) {
  const url = buildUrl(renderApiBase, pathname, query);
  return httpJson({
    url,
    method,
    headers: renderAuthHeaders,
    body,
    okStatuses
  });
}

async function getServiceById(serviceId) {
  const res = await renderRequest({
    method: 'GET',
    pathname: `/services/${encodeURIComponent(serviceId)}`,
    okStatuses: [200]
  });
  const service = normalizeService(res.body);
  if (!service?.id) {
    throw new Error(`unable to resolve service payload by id: ${serviceId}`);
  }
  return service;
}

async function listServices(query = {}) {
  const services = [];
  let cursor = null;
  do {
    const response = await renderRequest({
      method: 'GET',
      pathname: '/services',
      query: cleanObject({
        ...query,
        limit: 100,
        cursor
      }),
      okStatuses: [200]
    });
    const rows = toServiceRows(response.body);
    services.push(...rows.map(row => row.service));
    cursor = rows.length > 0 ? rows[rows.length - 1].cursor : null;
  } while (cursor);
  return services;
}

async function listServicesByName() {
  return listServices({
    name: renderServiceName,
    type: renderServiceType,
    ownerId: resolvedRenderOwnerId ? [resolvedRenderOwnerId] : undefined
  });
}

async function listOwners() {
  const owners = [];
  let cursor = null;
  do {
    const response = await renderRequest({
      method: 'GET',
      pathname: '/owners',
      query: cleanObject({
        limit: 100,
        cursor
      }),
      okStatuses: [200]
    });
    const rows = toOwnerRows(response.body);
    owners.push(...rows.map(row => row.owner));
    cursor = rows.length > 0 ? rows[rows.length - 1].cursor : null;
  } while (cursor);
  return owners;
}

function uniqueOwnerIds(values) {
  return [...new Set(values.map(v => trimOrNull(v)).filter(Boolean))];
}

function ownerMatchesHint(owner, hint) {
  const normalizedHint = hint.trim().toLowerCase();
  const candidates = [
    owner?.name,
    owner?.slug,
    owner?.email,
    owner?.id
  ]
    .map(v => trimOrNull(v))
    .filter(Boolean)
    .map(v => v.toLowerCase());
  return candidates.includes(normalizedHint);
}

async function resolveOwnerIdForCreate() {
  if (resolvedRenderOwnerId) {
    operations.push({
      op: 'render.owner.resolved',
      source: 'env',
      owner_id: resolvedRenderOwnerId
    });
    return resolvedRenderOwnerId;
  }

  let owners = [];
  try {
    owners = await listOwners();
    operations.push({
      op: 'render.owner.discovery.owners',
      owners_count: owners.length
    });
  } catch (error) {
    operations.push({
      op: 'render.owner.discovery.owners_unavailable',
      error: String(error?.message ?? error)
    });
  }

  if (owners.length > 0) {
    let candidates = owners;
    if (renderOwnerNameHint) {
      candidates = owners.filter(owner => ownerMatchesHint(owner, renderOwnerNameHint));
      if (candidates.length === 0) {
        throw new Error(`RENDER_OWNER_NAME did not match any Render owners: ${renderOwnerNameHint}`);
      }
    }

    const ids = uniqueOwnerIds(candidates.map(owner => owner?.id));
    if (ids.length === 1) {
      resolvedRenderOwnerId = ids[0];
      operations.push({
        op: 'render.owner.resolved',
        source: renderOwnerNameHint ? 'owners_api_by_name' : 'owners_api_single',
        owner_id: resolvedRenderOwnerId,
        owner: ownerIdentity(candidates[0])
      });
      return resolvedRenderOwnerId;
    }

    const names = candidates.map(owner => ownerIdentity(owner)).filter(Boolean).sort();
    throw new Error(
      `RENDER_OWNER_ID is required: multiple owners detected (${names.join(' | ')})`
    );
  }

  const services = await listServices();
  const ids = uniqueOwnerIds(services.map(service => ownerIdFromService(service)));
  if (ids.length === 1) {
    resolvedRenderOwnerId = ids[0];
    operations.push({
      op: 'render.owner.resolved',
      source: 'services_fallback_single',
      owner_id: resolvedRenderOwnerId,
      services_scanned: services.length
    });
    return resolvedRenderOwnerId;
  }

  if (ids.length > 1) {
    throw new Error(
      `RENDER_OWNER_ID is required: multiple owner IDs found from services (${ids.join(', ')})`
    );
  }

  throw new Error('RENDER_OWNER_ID is required to create service (owner auto-discovery failed)');
}

async function createService() {
  const ownerId = await resolveOwnerIdForCreate();
  if (!renderRepo) throw new Error('RENDER_REPO_URL is required to create service');

  const payload = cleanObject({
    type: renderServiceType,
    name: renderServiceName,
    ownerId,
    repo: renderRepo,
    branch: renderBranch,
    rootDir: renderRootDir,
    autoDeploy: renderAutoDeploy,
    serviceDetails: {
      runtime: renderRuntime,
      plan: renderPlan,
      region: renderRegion,
      healthCheckPath: healthPath,
      envSpecificDetails: {
        buildCommand: renderBuildCommand,
        startCommand: renderStartCommand
      }
    }
  });

  const response = await renderRequest({
    method: 'POST',
    pathname: '/services',
    body: payload,
    okStatuses: [201]
  });
  const service = normalizeService(response.body);
  if (!service?.id) {
    throw new Error('create service returned payload without service id');
  }
  return service;
}

async function ensureDisk(service) {
  const serviceId = trimOrNull(service?.id);
  if (!serviceId) throw new Error('service.id is required before disk attachment');

  const serviceDisk = service?.serviceDetails?.disk ?? null;
  if (serviceDisk?.id) {
    operations.push({
      op: 'render.disk.exists',
      disk_id: serviceDisk.id,
      mount_path: serviceDisk.mountPath,
      size_gb: serviceDisk.sizeGB
    });
    return serviceDisk;
  }

  const createDisk = async () => renderRequest({
    method: 'POST',
    pathname: '/disks',
    body: {
      name: renderDiskName,
      sizeGB: renderDiskSizeGb,
      mountPath: renderDiskMountPath,
      serviceId
    },
    okStatuses: [201]
  });

  let response = null;
  try {
    response = await createDisk();
  } catch (error) {
    const message = renderErrorMessage(error);
    const pendingDeployGuard = error?.status === 400 && /pending deploy/i.test(message);
    if (!pendingDeployGuard) throw error;

    operations.push({
      op: 'render.disk.pending_deploy_guard',
      service_id: serviceId,
      message
    });
    await waitForNoPendingDeploys(serviceId);
    response = await createDisk();
  }

  const disk = response?.body ?? null;
  operations.push({
    op: 'render.disk.created',
    disk_id: disk?.id ?? null,
    mount_path: disk?.mountPath ?? null,
    size_gb: disk?.sizeGB ?? null
  });
  return disk;
}

async function ensureEnvVars(serviceId) {
  const requiredEnv = {
    ...(scenario?.required_env ?? {}),
    STATE_BACKEND: 'sqlite',
    STATE_FILE: stateFilePath,
    HOST: trimOrNull(process.env.HOST) ?? '0.0.0.0'
  };

  const upserts = [];
  for (const [key, value] of Object.entries(requiredEnv)) {
    const response = await renderRequest({
      method: 'PUT',
      pathname: `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`,
      body: { value: String(value) },
      okStatuses: [200]
    });
    upserts.push({
      key: response.body?.key ?? key,
      value_set: true
    });
  }

  operations.push({
    op: 'render.env.upsert',
    keys: upserts.map(item => item.key).sort()
  });
}

async function triggerDeploy(serviceId) {
  const response = await renderRequest({
    method: 'POST',
    pathname: `/services/${encodeURIComponent(serviceId)}/deploys`,
    body: {},
    okStatuses: [201, 202]
  });

  const deployId = trimOrNull(response?.body?.id);
  operations.push({
    op: 'render.deploy.trigger',
    status_code: response.status,
    deploy_id: deployId
  });
  return deployId;
}

async function latestDeployId(serviceId) {
  const response = await renderRequest({
    method: 'GET',
    pathname: `/services/${encodeURIComponent(serviceId)}/deploys`,
    query: { limit: 1 },
    okStatuses: [200]
  });
  const rows = normalizeDeployListPayload(response.body);
  const deploy = rows.length > 0 ? normalizeDeploy(rows[0]) : null;
  return trimOrNull(deploy?.id ?? null);
}

async function waitForNoPendingDeploys(serviceId) {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < deployTimeoutSeconds * 1000) {
    const deployId = await latestDeployId(serviceId);
    if (!deployId) {
      operations.push({
        op: 'render.deploy.quiescent',
        service_id: serviceId,
        reason: 'no_deploys_found'
      });
      return;
    }

    const response = await renderRequest({
      method: 'GET',
      pathname: `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
      okStatuses: [200]
    });
    const status = currentDeployStatus(response.body);
    operations.push({
      op: 'render.deploy.status.before_disk_retry',
      service_id: serviceId,
      deploy_id: deployId,
      status
    });
    if (!isPendingDeployStatus(status)) return;

    await sleep(deployPollSeconds * 1000);
  }
  throw new Error(`timed out waiting for pending deploy to settle before disk attach (timeout=${deployTimeoutSeconds}s)`);
}

async function pollDeployUntilLive(serviceId, deployIdSeed) {
  const startedAtMs = Date.now();
  let deployId = deployIdSeed;

  while (Date.now() - startedAtMs < deployTimeoutSeconds * 1000) {
    if (!deployId) {
      deployId = await latestDeployId(serviceId);
      if (!deployId) {
        await sleep(deployPollSeconds * 1000);
        continue;
      }
    }

    const response = await renderRequest({
      method: 'GET',
      pathname: `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
      okStatuses: [200]
    });
    const deploy = normalizeDeploy(response.body);
    const status = currentDeployStatus(response.body);
    if (deploy?.id) deployId = deploy.id;
    deployStatusTrail.push({
      at: new Date().toISOString(),
      deploy_id: deployId,
      status
    });

    if (status === 'live') {
      operations.push({
        op: 'render.deploy.live',
        deploy_id: deployId,
        status
      });
      return { deployId, status };
    }

    if (['build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed', 'failed'].includes(String(status))) {
      throw new Error(`render deploy failed with status=${status} deploy_id=${deployId}`);
    }

    await sleep(deployPollSeconds * 1000);
  }

  throw new Error(`timed out waiting for deploy to become live (timeout=${deployTimeoutSeconds}s)`);
}

async function smokeRequest({ baseUrl, method, route, headers = {}, body, okStatuses = [200] }) {
  return httpJson({
    url: `${baseUrl}${route}`,
    method,
    headers,
    body,
    okStatuses
  });
}

async function waitForHealth(baseUrl, label) {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < deployTimeoutSeconds * 1000) {
    try {
      const response = await smokeRequest({
        baseUrl,
        method: 'GET',
        route: healthPath,
        okStatuses: [200]
      });

      const backend = response.body?.store_backend ?? null;
      const mode = response.body?.persistence_mode ?? null;
      const ok = backend === expectedHealthBackend && mode === expectedHealthMode;
      if (ok) {
        operations.push({
          op: `smoke.health.${label}`,
          ok: true,
          store_backend: backend,
          persistence_mode: mode,
          intents: Number(response.body?.state?.intents ?? 0)
        });
        return response.body;
      }
    } catch {
      // keep polling while service comes up
    }
    await sleep(deployPollSeconds * 1000);
  }

  throw new Error(`timed out waiting for health on ${label}`);
}

function smokeIntentRequest(intent) {
  return {
    intent: {
      ...intent
    }
  };
}

async function runSmokeApi(baseUrl) {
  const userWriteHeadersBase = smokeHeaders({
    actorType: smokeUserActor.type,
    actorId: smokeUserActor.id,
    scopes: ['swap_intents:write']
  });
  const userReadHeaders = smokeHeaders({
    actorType: smokeUserActor.type,
    actorId: smokeUserActor.id,
    scopes: ['swap_intents:read']
  });
  const partnerWriteHeadersBase = smokeHeaders({
    actorType: smokePartnerActor.type,
    actorId: smokePartnerActor.id,
    scopes: ['settlement:write']
  });
  const partnerReadHeaders = smokeHeaders({
    actorType: smokePartnerActor.type,
    actorId: smokePartnerActor.id,
    scopes: ['settlement:read']
  });

  for (let i = 0; i < smokeIntents.length; i += 1) {
    const intent = smokeIntents[i];
    const headers = {
      ...userWriteHeadersBase,
      'idempotency-key': idempotencyKey('m113-intent', i + 1)
    };
    const response = await smokeRequest({
      baseUrl,
      method: 'POST',
      route: '/swap-intents',
      headers,
      body: smokeIntentRequest(intent),
      okStatuses: [200]
    });
    operations.push({
      op: 'smoke.swapIntents.create',
      index: i + 1,
      intent_id: response.body?.intent?.id ?? intent.id
    });
  }

  const listBefore = await smokeRequest({
    baseUrl,
    method: 'GET',
    route: '/swap-intents',
    headers: userReadHeaders,
    okStatuses: [200]
  });
  const intentsBeforeRestart = Array.isArray(listBefore.body?.intents) ? listBefore.body.intents.length : 0;
  assert.ok(intentsBeforeRestart >= minIntentsAfterCreate, `expected at least ${minIntentsAfterCreate} intents after create`);

  const runResponse = await smokeRequest({
    baseUrl,
    method: 'POST',
    route: '/marketplace/matching/runs',
    headers: {
      ...partnerWriteHeadersBase,
      'idempotency-key': idempotencyKey('m113-run', 1)
    },
    body: smokeMatchingRequest,
    okStatuses: [200]
  });
  const runId = trimOrNull(runResponse.body?.run?.run_id);
  assert.ok(runId, 'marketplace matching run should return run_id');
  operations.push({
    op: 'smoke.marketplaceMatching.run',
    run_id: runId,
    selected_proposals_count: Number(runResponse.body?.run?.selected_proposals_count ?? 0)
  });

  const runGetResponse = await smokeRequest({
    baseUrl,
    method: 'GET',
    route: `/marketplace/matching/runs/${encodeURIComponent(runId)}`,
    headers: partnerReadHeaders,
    okStatuses: [200]
  });
  assert.equal(runGetResponse.body?.run?.run_id, runId, 'marketplace matching run get should match run id');
  operations.push({
    op: 'smoke.marketplaceMatchingRun.get',
    run_id: runId
  });

  return {
    intents_before_restart: intentsBeforeRestart,
    matching_run_id: runId
  };
}

let service = null;

if (renderServiceIdHint) {
  service = await getServiceById(renderServiceIdHint);
  operations.push({
    op: 'render.service.reused_by_id',
    service_id: service.id,
    name: service.name
  });
} else {
  const existing = await listServicesByName();
  if (existing.length > 0) {
    service = existing[0];
    operations.push({
      op: 'render.service.reused_by_name',
      service_id: service.id,
      name: service.name
    });
  } else {
    service = await createService();
    operations.push({
      op: 'render.service.created',
      service_id: service.id,
      name: service.name
    });
  }
}

await ensureDisk(service);
await ensureEnvVars(service.id);
const deployId = await triggerDeploy(service.id);
await pollDeployUntilLive(service.id, deployId);

service = await getServiceById(service.id);
const serviceUrl = trimOrNull(process.env.RENDER_SERVICE_URL) ?? trimOrNull(service?.serviceDetails?.url);
if (!serviceUrl) throw new Error('unable to resolve service URL; set RENDER_SERVICE_URL');

await waitForHealth(serviceUrl, 'post_deploy');
const smoke = await runSmokeApi(serviceUrl);

await renderRequest({
  method: 'POST',
  pathname: `/services/${encodeURIComponent(service.id)}/restart`,
  okStatuses: [200]
});
operations.push({
  op: 'render.service.restart',
  service_id: service.id
});

await waitForHealth(serviceUrl, 'post_restart');
const listAfterRestart = await smokeRequest({
  baseUrl: serviceUrl,
  method: 'GET',
  route: '/swap-intents',
  headers: smokeHeaders({
    actorType: smokeUserActor.type,
    actorId: smokeUserActor.id,
    scopes: ['swap_intents:read']
  }),
  okStatuses: [200]
});
const intentsAfterRestart = Array.isArray(listAfterRestart.body?.intents) ? listAfterRestart.body.intents.length : 0;
assert.ok(intentsAfterRestart >= minIntentsAfterRestart, `expected at least ${minIntentsAfterRestart} intents after restart`);
operations.push({
  op: 'smoke.swapIntents.list.after_restart',
  intents_count: intentsAfterRestart
});

const output = {
  milestone: MILESTONE,
  service: {
    id: service.id,
    name: service.name,
    dashboard_url: service.dashboardUrl ?? null,
    url: serviceUrl
  },
  smoke: {
    intents_before_restart: smoke.intents_before_restart,
    intents_after_restart: intentsAfterRestart,
    matching_run_id: smoke.matching_run_id
  },
  deploy_status_trail: deployStatusTrail,
  operations
};

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(output, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({
  milestone: MILESTONE,
  ok: true,
  service_id: service.id,
  service_url: serviceUrl,
  matching_run_id: smoke.matching_run_id,
  intents_after_restart: intentsAfterRestart
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  service_id: service.id,
  service_url: serviceUrl,
  matching_run_id: smoke.matching_run_id,
  intents_after_restart: intentsAfterRestart
}, null, 2));
