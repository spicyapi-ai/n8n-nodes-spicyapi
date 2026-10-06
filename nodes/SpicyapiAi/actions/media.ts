import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	DEFAULT_MAX_COST_USD,
	SERVER_WAIT_MODALITIES,
	SERVER_WAIT_SECONDS,
} from '../shared/constants';
import type { ModelSchema } from '../shared/schema';
import { isSettledForOutput } from '../shared/task';
import { apiCall, apiError, apiRequest } from '../transport/api';
import type { RunContext } from './common';
import {
	collectInput,
	downloadOutputs,
	getModelDetail,
	getModelId,
	keyFor,
	quoteWithinLimit,
	taskFailedError,
	waitDeadline,
	waitForTask,
} from './common';

interface GenerateOptions {
	binaryPropertyName?: string;
	callbackUrl?: string;
	downloadOutput?: boolean;
	maxWaitTime?: number;
	retentionSeconds?: number;
	waitForCompletion?: boolean;
}

/** Image / Video / Audio > Generate: quote, check the limit, create the task, wait, download. */
export async function generate(
	this: IExecuteFunctions,
	itemIndex: number,
	run: RunContext,
): Promise<INodeExecutionData[]> {
	const modelId = getModelId.call(this, itemIndex);
	const model = await getModelDetail.call(this, modelId, run, itemIndex);
	const schema = model.inputSchema as ModelSchema | undefined;
	const { input, fingerprint } = await collectInput.call(this, itemIndex, schema);

	const maxCost = Number(this.getNodeParameter('maxCost', itemIndex, DEFAULT_MAX_COST_USD));
	const options = this.getNodeParameter('generateOptions', itemIndex, {}) as GenerateOptions;
	const callbackUrl = options.callbackUrl?.trim() || undefined;
	const wait = options.waitForCompletion !== false;
	const binaryBase = options.binaryPropertyName?.trim() || 'data';

	let quote = await quoteWithinLimit.call(this, itemIndex, modelId, input, maxCost);

	// The key covers what SpicyAPI compares (model, input, callback URL) plus where in the
	// workflow this item is, with uploaded files identified by their bytes rather than by URI.
	const idempotencyKey = keyFor.call(this, itemIndex, {
		op: 'createTask',
		model: modelId,
		input: fingerprint,
		callBackUrl: callbackUrl ?? null,
	});
	const headers: IDataObject = { 'Idempotency-Key': idempotencyKey };
	const retention = Math.floor(Number(options.retentionSeconds) || 0);
	if (retention > 0) {
		headers['X-Spicy-Retention'] = String(retention);
	}
	// Most image and audio models finish within a minute, so the API can hold the request open
	// and answer with the finished task; video goes straight to polling.
	const serverWait = wait && SERVER_WAIT_MODALITIES.has(String(model.modality));

	let created: IDataObject | undefined;
	for (let attempt = 0; attempt < 2 && created === undefined; attempt++) {
		const body: IDataObject = {
			model: modelId,
			input,
			quoteId: quote.quoteId,
			expectedCost: quote.estimatedCost,
		};
		if (callbackUrl) {
			body.callBackUrl = callbackUrl;
		}
		const result = await apiCall.call(this, 'POST', '/api/v1/jobs/createTask', {
			qs: serverWait ? { wait: SERVER_WAIT_SECONDS } : undefined,
			body,
			headers,
			timeoutMs: serverWait ? (SERVER_WAIT_SECONDS + 40) * 1000 : 60_000,
			retryConflictOnce: true,
		});
		if (result.ok) {
			created = result.data;
		} else if (result.code === 40901 && attempt === 0) {
			// The price moved between quote and submit. Quote again (the limit is checked again)
			// and resend under the same key, so a task the server did accept is recovered rather
			// than created twice.
			quote = await quoteWithinLimit.call(this, itemIndex, modelId, input, maxCost);
		} else {
			throw apiError(this, result, itemIndex);
		}
	}
	if (created === undefined) {
		throw new NodeOperationError(this.getNode(), 'The task could not be created', { itemIndex });
	}

	const estimatedCost = created.estimatedCost ?? quote.estimatedCost;
	const taskId = String(created.taskId ?? '');
	if (!wait) {
		return [{ json: { ...created, model: created.model ?? modelId, estimatedCost } }];
	}

	const task = isSettledForOutput(created)
		? created
		: await waitForTask.call(
				this,
				taskId,
				waitDeadline(Number(options.maxWaitTime) || 0, created, model),
				itemIndex,
			);
	if (task.state !== 'succeeded') {
		throw taskFailedError.call(this, task, itemIndex);
	}
	const json: IDataObject = { ...task, estimatedCost: task.estimatedCost ?? estimatedCost };
	if (options.downloadOutput === false) {
		return [{ json }];
	}
	const binary = await downloadOutputs.call(this, task, binaryBase, itemIndex);
	return [{ json, binary }];
}

/** Model > Get Quote: the exact price of a request, without creating anything. */
export async function getQuote(
	this: IExecuteFunctions,
	itemIndex: number,
	run: RunContext,
): Promise<INodeExecutionData[]> {
	const modelId = getModelId.call(this, itemIndex);
	const model = await getModelDetail.call(this, modelId, run, itemIndex);
	const { input } = await collectInput.call(
		this,
		itemIndex,
		model.inputSchema as ModelSchema | undefined,
	);
	const quote = await apiRequest.call(
		this,
		'POST',
		'/api/v1/jobs/quote',
		{ body: { model: modelId, input } },
		itemIndex,
	);
	return [{ json: { model: modelId, ...quote, input } }];
}
