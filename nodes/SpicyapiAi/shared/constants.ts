export const CREDENTIAL_NAME = 'spicyapiAiApi';

export const DEFAULT_BASE_URL = 'https://api.spicyapi.ai';

/** Kept in step with package.json by a unit test. */
export const PACKAGE_VERSION = '0.1.1';

export const USER_AGENT = `SpicyAPI-n8n/${PACKAGE_VERSION}`;

/** The modality each node resource lists in its model picker. */
export const MODALITY_BY_RESOURCE: Record<string, string | undefined> = {
	image: 'image',
	video: 'video',
	audio: 'audio',
	chat: 'text',
	model: undefined,
};

export const DEFAULT_MAX_COST_USD = 2;

/** createTask may hold the connection until the task is done; the API clamps this at 60. */
export const SERVER_WAIT_SECONDS = 50;

/** Modalities whose models usually finish within SERVER_WAIT_SECONDS. */
export const SERVER_WAIT_MODALITIES = new Set(['image', 'audio']);

export const POLL_INITIAL_MS = 2000;
export const POLL_MAX_MS = 10000;
export const POLL_FACTOR = 1.5;

/** Grace period after a task's own deadline before the node stops waiting. */
export const DEADLINE_GRACE_SECONDS = 300;
export const FALLBACK_TASK_TIMEOUT_SECONDS = 3600;
