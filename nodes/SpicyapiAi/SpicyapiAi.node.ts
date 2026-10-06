import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { RunContext } from './actions/common';
import { newRunContext } from './actions/common';
import { generate, getQuote } from './actions/media';
import {
	getBalance,
	getManyModels,
	getModel,
	getTask,
	messageModel,
	uploadBinary,
} from './actions/resources';
import {
	chatProperties,
	fileProperties,
	inputProperties,
	modelListProperties,
	modelProperty,
	operationProperties,
	resourceProperty,
	taskProperties,
} from './descriptions';
import { listSearch, loadOptions, resourceMapping } from './methods';
import { CREDENTIAL_NAME } from './shared/constants';

type Operation = (
	this: IExecuteFunctions,
	itemIndex: number,
	run: RunContext,
) => Promise<INodeExecutionData[]>;

const OPERATIONS: Record<string, Operation> = {
	'image:generate': generate,
	'video:generate': generate,
	'audio:generate': generate,
	'task:get': getTask,
	'file:upload': uploadBinary,
	'model:getAll': getManyModels,
	'model:get': getModel,
	'model:getQuote': getQuote,
	'account:getBalance': getBalance,
	'chat:message': messageModel,
};

export class SpicyapiAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SpicyAPI',
		name: 'spicyapiAi',
		icon: { light: 'file:spicyapi.svg', dark: 'file:spicyapi.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Generate images, video and audio and chat with 200+ AI models through SpicyAPI (spicyapi.ai)',
		defaults: {
			name: 'SpicyAPI',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		properties: [
			resourceProperty,
			...operationProperties,
			modelProperty,
			...inputProperties,
			...taskProperties,
			...fileProperties,
			...modelListProperties,
			...chatProperties,
		],
	};

	methods = { listSearch, loadOptions, resourceMapping };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const run = newRunContext();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const handler = OPERATIONS[`${resource}:${operation}`];
				if (!handler) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for "${resource}"`,
						{ itemIndex },
					);
				}
				const results = await handler.call(this, itemIndex, run);
				for (const result of results) {
					returnData.push({ ...result, pairedItem: { item: itemIndex } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const context = (error as NodeApiError).context ?? {};
					returnData.push({
						json: {
							error: (error as Error).message,
							description: (error as NodeApiError).description ?? null,
							taskId: (context.taskId as string) ?? null,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeApiError) {
					error.context.itemIndex = itemIndex;
					// Re-wrapping a NodeApiError hands back the same instance, context included.
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
				}
				if (error instanceof NodeOperationError) {
					error.context.itemIndex = itemIndex;
					throw new NodeOperationError(this.getNode(), error, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
