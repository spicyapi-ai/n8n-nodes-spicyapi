import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { isSettledForOutput } from '../shared/task';
import { apiRequest, chatCompletion, modelPath, uploadFile } from '../transport/api';
import type { RunContext } from './common';
import {
	downloadOutputs,
	getModelId,
	keyFor,
	parseJsonObject,
	readBinary,
	waitDeadline,
	waitForTask,
} from './common';

// -- Task -----------------------------------------------------------------------

interface TaskOptions {
	binaryPropertyName?: string;
	downloadOutput?: boolean;
	maxWaitTime?: number;
	waitForCompletion?: boolean;
}

/** Task > Get: read a task, optionally wait for it and download its files. */
export async function getTask(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const taskId = String(this.getNodeParameter('taskId', itemIndex, '')).trim();
	if (!taskId) {
		throw new NodeOperationError(this.getNode(), 'Task ID is empty', { itemIndex });
	}
	const options = this.getNodeParameter('taskOptions', itemIndex, {}) as TaskOptions;
	let task = await apiRequest.call(
		this,
		'GET',
		'/api/v1/jobs/recordInfo',
		{ qs: { taskId } },
		itemIndex,
	);
	if (options.waitForCompletion === true && !isSettledForOutput(task)) {
		task = await waitForTask.call(
			this,
			taskId,
			waitDeadline(Number(options.maxWaitTime) || 0, task),
			itemIndex,
		);
	}
	if (options.downloadOutput === false || task.state !== 'succeeded') {
		return [{ json: task }];
	}
	const binaryBase = options.binaryPropertyName?.trim() || 'data';
	const binary = await downloadOutputs.call(this, task, binaryBase, itemIndex);
	return [{ json: task, binary }];
}

// -- File -------------------------------------------------------------------------

/** File > Upload: a binary from the incoming item becomes a spicy:// URI for task input. */
export async function uploadBinary(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const property =
		String(this.getNodeParameter('binaryPropertyName', itemIndex, 'data')).trim() || 'data';
	const options = this.getNodeParameter('fileOptions', itemIndex, {}) as { contentType?: string };
	const { data, contentType, fileName } = await readBinary.call(
		this,
		itemIndex,
		property,
		options.contentType,
	);
	const { uri, fileId } = await uploadFile.call(this, data, contentType, itemIndex);
	return [
		{
			json: { uri, fileId, fileName: fileName ?? null, mimeType: contentType, bytes: data.length },
		},
	];
}

// -- Model ----------------------------------------------------------------------------

const LIST_FIELDS_DROPPED = new Set(['inputSchema', 'examples']);

/** Model > Get Many: the catalogue, with prices, filtered by modality and keyword. */
export async function getManyModels(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const modality = String(this.getNodeParameter('modality', itemIndex, 'all'));
	const search = String(this.getNodeParameter('search', itemIndex, '')).trim();
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : Number(this.getNodeParameter('limit', itemIndex, 50));
	const data = await apiRequest.call(
		this,
		'GET',
		'/api/v1/models',
		{
			qs: {
				...(modality !== 'all' ? { modality } : {}),
				...(search ? { search } : {}),
			},
		},
		itemIndex,
	);
	const items = Array.isArray(data.items) ? (data.items as IDataObject[]) : [];
	return items
		.filter((item) => !!item && typeof item === 'object')
		.slice(0, limit)
		.map((item) => {
			const json: IDataObject = {};
			for (const [key, value] of Object.entries(item)) {
				if (!LIST_FIELDS_DROPPED.has(key)) {
					json[key] = value;
				}
			}
			return { json };
		});
}

/** Model > Get: one model with its input schema, examples and prices. */
export async function getModel(
	this: IExecuteFunctions,
	itemIndex: number,
	run: RunContext,
): Promise<INodeExecutionData[]> {
	const modelId = getModelId.call(this, itemIndex);
	let pending = run.models.get(modelId);
	if (!pending) {
		pending = apiRequest.call(this, 'GET', modelPath(modelId), {}, itemIndex);
		run.models.set(modelId, pending);
	}
	return [{ json: await pending }];
}

// -- Account ------------------------------------------------------------------------------

/** Account > Get Balance: available, held and total, in US dollars. */
export async function getBalance(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const data = await apiRequest.call(this, 'GET', '/api/v1/chat/credit', {}, itemIndex);
	return [{ json: data }];
}

// -- Chat ---------------------------------------------------------------------------------

interface ChatOptions {
	additionalBody?: string | IDataObject;
	jsonOutput?: boolean;
	maxTokens?: number;
	systemMessage?: string;
	temperature?: number;
}

function headerText(headers: IDataObject, name: string): string | undefined {
	const raw = headers[name];
	if (Array.isArray(raw)) {
		return raw.map(String).join(', ');
	}
	return typeof raw === 'string' && raw ? raw : undefined;
}

function messageText(message: IDataObject | undefined): string {
	const content = message?.content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === 'object' && typeof (part as IDataObject).text === 'string'
					? ((part as IDataObject).text as string)
					: '',
			)
			.join('');
	}
	return '';
}

/** Chat > Message a Model: one non-streaming chat completion. */
export async function messageModel(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const modelId = getModelId.call(this, itemIndex);
	const prompt = String(this.getNodeParameter('chatPrompt', itemIndex, ''));
	if (!prompt.trim()) {
		throw new NodeOperationError(this.getNode(), 'The prompt is empty', { itemIndex });
	}
	const options = this.getNodeParameter('chatOptions', itemIndex, {}) as ChatOptions;
	const simplify = this.getNodeParameter('simplifyOutput', itemIndex, true) as boolean;

	const messages: IDataObject[] = [];
	if (options.systemMessage?.trim()) {
		messages.push({ role: 'system', content: options.systemMessage });
	}
	messages.push({ role: 'user', content: prompt });
	const body: IDataObject = { model: modelId, messages };
	if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
		body.max_tokens = Math.floor(options.maxTokens);
	}
	if (typeof options.temperature === 'number') {
		body.temperature = options.temperature;
	}
	if (options.jsonOutput === true) {
		body.response_format = { type: 'json_object' };
	}
	Object.assign(
		body,
		parseJsonObject.call(this, options.additionalBody, 'Additional Body Fields (JSON)', itemIndex),
	);

	const idempotencyKey = keyFor.call(this, itemIndex, { op: 'chat', body });
	const { body: response, headers } = await chatCompletion.call(
		this,
		body,
		idempotencyKey,
		itemIndex,
	);

	const taskId = headerText(headers, 'x-spicy-task-id');
	const ignoredHeader = headerText(headers, 'x-spicy-ignored-params');
	const ignoredParams = ignoredHeader
		? ignoredHeader
				.split(',')
				.map((name) => name.trim())
				.filter(Boolean)
		: undefined;
	const extras: IDataObject = {};
	if (taskId) {
		extras.taskId = taskId;
	}
	if (ignoredParams?.length) {
		extras.ignoredParams = ignoredParams;
	}
	if (!simplify) {
		return [{ json: { ...response, ...extras } }];
	}
	const choices = Array.isArray(response.choices) ? (response.choices as IDataObject[]) : [];
	const choice = choices[0];
	const message = choice?.message as IDataObject | undefined;
	const json: IDataObject = {
		text: messageText(message),
		model: response.model ?? modelId,
		finishReason: choice?.finish_reason ?? null,
		usage: response.usage ?? null,
		...extras,
	};
	const reasoning = message?.reasoning_content ?? message?.reasoning;
	if (typeof reasoning === 'string' && reasoning) {
		json.reasoning = reasoning;
	}
	return [{ json }];
}
