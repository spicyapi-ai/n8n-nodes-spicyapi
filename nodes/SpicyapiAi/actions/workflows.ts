import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	DEADLINE_GRACE_SECONDS,
	FALLBACK_TASK_TIMEOUT_SECONDS,
	POLL_FACTOR,
	POLL_INITIAL_MS,
	POLL_MAX_MS,
} from '../shared/constants';
import { isSettledForOutput, taskFailureHint } from '../shared/task';
import { apiCall, apiError, apiRequest, cancellableSleep } from '../transport/api';
import {
	downloadOutputs,
	keyFor,
	parseJsonObject,
	readBinary,
	uploadCached,
} from './common';

interface WorkflowRunOptions {
	binaryPropertyName?: string;
	downloadOutput?: boolean;
	maxWaitTime?: number;
	retentionSeconds?: number;
	waitForCompletion?: boolean;
}

interface WorkflowStatusOptions {
	binaryPropertyName?: string;
	downloadOutput?: boolean;
	maxWaitTime?: number;
	waitForCompletion?: boolean;
}

function workflowMediaField(preset: string): 'image_url' | 'video_url' {
	return preset.startsWith('video-') ? 'video_url' : 'image_url';
}

function workflowWaitDeadline(maxWaitSeconds: number, now = Date.now()): number {
	if (maxWaitSeconds > 0) {
		return now + maxWaitSeconds * 1000;
	}
	return now + (FALLBACK_TASK_TIMEOUT_SECONDS * 2 + DEADLINE_GRACE_SECONDS) * 1000;
}

function workflowFailedError(
	this: IExecuteFunctions,
	workflow: IDataObject,
	itemIndex: number,
): NodeOperationError {
	const code =
		typeof workflow.errorCode === 'string' && workflow.errorCode
			? workflow.errorCode
			: String(workflow.state);
	const message =
		typeof workflow.errorMessage === 'string' && workflow.errorMessage
			? workflow.errorMessage
			: `the workflow ended as ${String(workflow.state)}`;
	const error = new NodeOperationError(this.getNode(), `${code}: ${message}`, {
		itemIndex,
		description: `${taskFailureHint(workflow.errorCode)} Workflow ID: ${String(workflow.workflowId ?? '')}.`,
	});
	error.context.workflowId = workflow.workflowId;
	return error;
}

async function waitForWorkflow(
	this: IExecuteFunctions,
	workflowId: string,
	deadlineMs: number,
	itemIndex: number,
): Promise<IDataObject> {
	let interval = POLL_INITIAL_MS;
	const path = `/api/v1/workflows/${encodeURIComponent(workflowId)}`;
	for (;;) {
		const result = await apiCall.call(this, 'GET', path);
		if (result.ok) {
			if (isSettledForOutput(result.data)) {
				return result.data;
			}
		} else if (
			result.status > 0 &&
			result.status < 500 &&
			result.status !== 408 &&
			result.status !== 429
		) {
			throw apiError(this, result, itemIndex);
		}
		if (Date.now() + interval > deadlineMs) {
			throw new NodeOperationError(
				this.getNode(),
				`Workflow ${workflowId} did not finish within the wait time`,
				{
					itemIndex,
					description: `It may still be running on SpicyAPI. Do not resubmit it; fetch progress later with Workflow > Get Workflow Status and workflow ID ${workflowId}, or raise "Max Wait Time".`,
				},
			);
		}
		if (!(await cancellableSleep(this, interval))) {
			throw new NodeOperationError(this.getNode(), `Stopped waiting for workflow ${workflowId}`, {
				itemIndex,
				description:
					'The current step keeps running on SpicyAPI. Fetch progress later with Workflow > Get Workflow Status.',
			});
		}
		interval = Math.min(interval * POLL_FACTOR, POLL_MAX_MS);
	}
}

/** Workflow > List Presets: official managed multi-step workflows and their input schemas. */
export async function listWorkflowPresets(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const data = await apiRequest.call(this, 'GET', '/api/v1/workflows', {}, itemIndex);
	const items = Array.isArray(data.items) ? (data.items as IDataObject[]) : [];
	return items
		.filter((item) => !!item && typeof item === 'object')
		.map((item) => ({ json: item }));
}

/** Workflow > Run Workflow: start a managed preset workflow, optionally poll and download output. */
export async function runWorkflow(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const preset = String(this.getNodeParameter('workflowPreset', itemIndex, '')).trim();
	if (!preset) {
		throw new NodeOperationError(this.getNode(), 'Choose a workflow preset', { itemIndex });
	}
	const prompt = String(this.getNodeParameter('workflowPrompt', itemIndex, '')).trim();
	const mediaSource = String(this.getNodeParameter('workflowMediaSource', itemIndex, 'url'));
	const extra = parseJsonObject.call(
		this,
		this.getNodeParameter('workflowInputParameters', itemIndex, '{}'),
		'Additional Input Parameters (JSON)',
		itemIndex,
	);
	const options = this.getNodeParameter(
		'workflowRunOptions',
		itemIndex,
		{},
	) as WorkflowRunOptions;

	const mediaField = workflowMediaField(preset);
	const input: IDataObject = {};
	const fingerprint: IDataObject = {};

	if (prompt) {
		input.prompt = prompt;
		fingerprint.prompt = prompt;
	}

	if (mediaSource === 'binary') {
		const property =
			String(this.getNodeParameter('workflowBinaryProperty', itemIndex, 'data')).trim() || 'data';
		const binary = await readBinary.call(this, itemIndex, property);
		const uploaded = await uploadCached.call(this, binary.data, binary.contentType, itemIndex);
		input[mediaField] = uploaded.uri;
		fingerprint[mediaField] = `sha256:${uploaded.digest}`;
	} else {
		const url = String(this.getNodeParameter('workflowMediaUrl', itemIndex, '')).trim();
		if (url) {
			input[mediaField] = url;
			fingerprint[mediaField] = url;
		}
	}

	Object.assign(input, extra);
	Object.assign(fingerprint, extra);

	if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
		throw new NodeOperationError(this.getNode(), 'Prompt is required', { itemIndex });
	}
	if (typeof input[mediaField] !== 'string' || !String(input[mediaField]).trim()) {
		throw new NodeOperationError(
			this.getNode(),
			`Workflow preset '${preset}' requires '${mediaField}'`,
			{
				itemIndex,
				description:
					'Provide a source URL, switch Source Media to Binary File, or include it in Additional Input Parameters (JSON).',
			},
		);
	}

	const idempotencyKey = keyFor.call(this, itemIndex, {
		op: 'runWorkflow',
		preset,
		input: fingerprint,
	});
	const headers: IDataObject = { 'Idempotency-Key': idempotencyKey };
	const retention = Math.floor(Number(options.retentionSeconds) || 0);
	if (retention > 0) {
		headers['X-Spicy-Retention'] = String(retention);
	}

	const created = await apiRequest.call(
		this,
		'POST',
		'/api/v1/workflows/run',
		{
			body: { preset, input },
			headers,
			retryConflictOnce: true,
		},
		itemIndex,
	);

	const wait = options.waitForCompletion !== false;
	const workflowId = String(created.workflowId ?? '');
	if (!wait) {
		return [{ json: created }];
	}
	if (!workflowId) {
		throw new NodeOperationError(
			this.getNode(),
			'The workflow started without returning a workflowId',
			{ itemIndex },
		);
	}

	const workflow = isSettledForOutput(created)
		? created
		: await waitForWorkflow.call(
				this,
				workflowId,
				workflowWaitDeadline(Number(options.maxWaitTime) || 0),
				itemIndex,
			);
	if (workflow.state !== 'succeeded') {
		throw workflowFailedError.call(this, workflow, itemIndex);
	}
	if (options.downloadOutput === false) {
		return [{ json: workflow }];
	}
	const binaryBase = options.binaryPropertyName?.trim() || 'data';
	const binary = await downloadOutputs.call(this, workflow, binaryBase, itemIndex);
	return [{ json: workflow, binary }];
}

/** Workflow > Get Workflow Status: poll/advance a workflow run and optionally download outputs. */
export async function getWorkflowStatus(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const workflowId = String(this.getNodeParameter('workflowId', itemIndex, '')).trim();
	if (!workflowId) {
		throw new NodeOperationError(this.getNode(), 'Workflow ID is empty', { itemIndex });
	}
	const options = this.getNodeParameter(
		'workflowStatusOptions',
		itemIndex,
		{},
	) as WorkflowStatusOptions;
	let workflow = await apiRequest.call(
		this,
		'GET',
		`/api/v1/workflows/${encodeURIComponent(workflowId)}`,
		{},
		itemIndex,
	);
	if (options.waitForCompletion === true && !isSettledForOutput(workflow)) {
		workflow = await waitForWorkflow.call(
			this,
			workflowId,
			workflowWaitDeadline(Number(options.maxWaitTime) || 0),
			itemIndex,
		);
	}
	if (options.downloadOutput === false || workflow.state !== 'succeeded') {
		return [{ json: workflow }];
	}
	const binaryBase = options.binaryPropertyName?.trim() || 'data';
	const binary = await downloadOutputs.call(this, workflow, binaryBase, itemIndex);
	return [{ json: workflow, binary }];
}
