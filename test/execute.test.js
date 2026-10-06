'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { envelope, fakeApi, fakeExecuteContext, fixtures, response, runNode } = require('./helpers');

const T2I = 'alibaba/z-image-turbo/text-to-image';
const I2V = 'bytedance/seedance-1.5-pro/image-to-video';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const modelResponse = (id) => response(200, envelope(fixtures[id]));

function imageParams(overrides = {}) {
	return {
		resource: 'image',
		operation: 'generate',
		model: { mode: 'list', value: T2I },
		prompt: 'A red bicycle leaning on a brick wall, morning light',
		mediaInputs: {},
		modelParameters: {
			mappingMode: 'defineBelow',
			value: { aspect_ratio: '1:1', seed: 7 },
			schema: [],
		},
		additionalParameters: '{}',
		maxCost: 2,
		generateOptions: {},
		...overrides,
	};
}

const finishedTask = {
	taskId: 'job_1',
	model: T2I,
	state: 'succeeded',
	cost: '0.01',
	settled: true,
	output: {
		assets: [
			{ url: 'https://files.test/job_1.png', mime: 'image/png', expiresAt: '2026-10-06T12:00:00Z' },
		],
	},
};

describe('Generate', () => {
	it('stops before creating a task when the quote is above the limit', async () => {
		const api = fakeApi({
			[`GET /api/v1/models/${T2I}`]: [modelResponse(T2I)],
			'POST /api/v1/jobs/quote': [
				response(200, envelope({ quoteId: 'q1', estimatedCost: '2.5', maxCharge: '2.5' })),
			],
		});
		const context = fakeExecuteContext({ params: imageParams(), api });
		await assert.rejects(runNode(context), (error) => {
			assert.match(error.message, /could cost up to \$2\.50, above the limit of \$2\.00/);
			assert.match(error.message, /Nothing was charged/);
			return true;
		});
		assert.ok(!api.calls.some((call) => call.key === 'POST /api/v1/jobs/createTask'));
	});

	it('quotes, creates the task with a deterministic key, and returns the image as binary', async () => {
		const runOnce = async () => {
			const api = fakeApi({
				[`GET /api/v1/models/${T2I}`]: [modelResponse(T2I)],
				'POST /api/v1/jobs/quote': [
					response(200, envelope({ quoteId: 'q1', estimatedCost: '0.01', maxCharge: '0.01' })),
				],
				'POST /api/v1/jobs/createTask': [response(200, envelope(finishedTask))],
				'GET /job_1.png': [response(200, PNG, { 'content-type': 'image/png' })],
			});
			const output = await runNode(fakeExecuteContext({ params: imageParams(), api }));
			return { api, output };
		};

		const first = await runOnce();
		const create = first.api.calls.find((call) => call.key === 'POST /api/v1/jobs/createTask');
		assert.equal(create.kind, 'auth');
		assert.deepEqual(create.options.body, {
			model: T2I,
			input: {
				prompt: 'A red bicycle leaning on a brick wall, morning light',
				aspect_ratio: '1:1',
				seed: 7,
			},
			quoteId: 'q1',
			expectedCost: '0.01',
		});
		// Image models get the server-side wait, so most finish in one request.
		assert.equal(create.options.qs.wait, 50);
		const key = create.options.headers['Idempotency-Key'];
		assert.match(key, /^n8n-[0-9a-f]{64}$/);

		const download = first.api.calls.find((call) => call.key === 'GET /job_1.png');
		assert.equal(download.kind, 'plain', 'output files are fetched without the API key');

		const [items] = first.output;
		assert.equal(items.length, 1);
		assert.equal(items[0].json.taskId, 'job_1');
		assert.equal(items[0].json.estimatedCost, '0.01');
		assert.equal(items[0].binary.data.mimeType, 'image/png');
		assert.equal(items[0].binary.data.fileName, 'job_1.png');
		assert.deepEqual(items[0].pairedItem, { item: 0 });

		// A retry of the same item (same execution, node, run and input) sends the same key.
		const second = await runOnce();
		const again = second.api.calls.find((call) => call.key === 'POST /api/v1/jobs/createTask');
		assert.equal(again.options.headers['Idempotency-Key'], key);
	});

	it('gives each item and each loop pass its own key', async () => {
		const keys = [];
		for (const runIndex of [0, 1]) {
			const api = fakeApi({
				[`GET /api/v1/models/${T2I}`]: [modelResponse(T2I)],
				'POST /api/v1/jobs/quote': [
					response(200, envelope({ quoteId: 'q', estimatedCost: '0.01' })),
				],
				'POST /api/v1/jobs/createTask': [response(200, envelope(finishedTask))],
				'GET /job_1.png': [response(200, PNG)],
			});
			const items = [{ json: {} }, { json: {} }];
			await runNode(fakeExecuteContext({ params: imageParams(), api, items, runIndex }));
			for (const call of api.calls.filter((c) => c.key === 'POST /api/v1/jobs/createTask')) {
				keys.push(call.options.headers['Idempotency-Key']);
			}
		}
		assert.equal(keys.length, 4);
		assert.equal(new Set(keys).size, 4);
	});

	it('quotes again after a price change and resends under the same key', async () => {
		const api = fakeApi({
			[`GET /api/v1/models/${T2I}`]: [modelResponse(T2I)],
			'POST /api/v1/jobs/quote': [
				response(200, envelope({ quoteId: 'q1', estimatedCost: '0.01' })),
				response(200, envelope({ quoteId: 'q2', estimatedCost: '0.012' })),
			],
			'POST /api/v1/jobs/createTask': [
				response(409, { code: 40901, msg: 'Quote no longer matches', request_id: 'req_x' }),
				response(200, envelope(finishedTask)),
			],
			'GET /job_1.png': [response(200, PNG)],
		});
		await runNode(fakeExecuteContext({ params: imageParams(), api }));
		const creates = api.calls.filter((call) => call.key === 'POST /api/v1/jobs/createTask');
		assert.equal(creates.length, 2);
		assert.equal(
			creates[0].options.headers['Idempotency-Key'],
			creates[1].options.headers['Idempotency-Key'],
		);
		assert.equal(creates[1].options.body.quoteId, 'q2');
		assert.equal(creates[1].options.body.expectedCost, '0.012');
	});

	it('does not resend when the new quote is above the limit', async () => {
		const api = fakeApi({
			[`GET /api/v1/models/${T2I}`]: [modelResponse(T2I)],
			'POST /api/v1/jobs/quote': [
				response(200, envelope({ quoteId: 'q1', estimatedCost: '1.9' })),
				response(200, envelope({ quoteId: 'q2', estimatedCost: '2.1' })),
			],
			'POST /api/v1/jobs/createTask': [
				response(409, { code: 40901, msg: 'Quote no longer matches', request_id: 'req_x' }),
			],
		});
		await assert.rejects(
			runNode(fakeExecuteContext({ params: imageParams(), api })),
			/above the limit/,
		);
		assert.equal(api.calls.filter((call) => call.key === 'POST /api/v1/jobs/createTask').length, 1);
	});

	it('uploads a binary input in three steps and keys the request by the file bytes', async () => {
		const keys = [];
		for (const attempt of [1, 2]) {
			const api = fakeApi({
				[`GET /api/v1/models/${I2V}`]: [modelResponse(I2V)],
				'POST /api/v1/common/upload-url': [
					response(
						200,
						envelope({
							fileId: `fil_${attempt}`,
							uploadUrl: `https://upload.test/put/${attempt}`,
							method: 'PUT',
							headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) },
							maxBytes: 10485760,
						}),
					),
				],
				[`PUT /put/${attempt}`]: [response(200, '')],
				[`POST /api/v1/files/fil_${attempt}/commit`]: [
					response(200, envelope({ uri: `spicy://f/fil_${attempt}` })),
				],
				'POST /api/v1/jobs/quote': [
					response(200, envelope({ quoteId: 'q', estimatedCost: '0.06' })),
				],
				'POST /api/v1/jobs/createTask': [
					response(202, envelope({ taskId: 'job_v', state: 'queued', estimatedCost: '0.06' })),
				],
			});
			const items = [
				{
					json: {},
					binary: {
						photo: { data: PNG.toString('base64'), mimeType: 'image/png', fileName: 'start.png' },
					},
				},
			];
			const params = {
				resource: 'video',
				operation: 'generate',
				model: { mode: 'id', value: I2V },
				prompt: 'The camera slowly pushes in',
				mediaInputs: { input: [{ field: 'image_url', source: 'binary', binaryProperty: 'photo' }] },
				modelParameters: { mappingMode: 'defineBelow', value: { resolution: '480p' }, schema: [] },
				additionalParameters: '{}',
				maxCost: 2,
				generateOptions: { waitForCompletion: false },
			};
			// Each attempt uses a different API key, so the upload cache cannot hand back the
			// first URI and the second attempt really uploads again.
			const context = fakeExecuteContext({ params, api, items });
			context.getCredentials = async () => ({
				apiKey: `sk-spicy-test-${attempt}`,
				baseUrl: 'https://api.test',
			});
			const [out] = await runNode(context);

			const put = api.calls.find((call) => call.key === `PUT /put/${attempt}`);
			assert.equal(put.kind, 'plain', 'the signed upload URL gets no API key');
			assert.equal(put.options.headers['Content-Type'], 'image/png');
			assert.ok(Buffer.isBuffer(put.options.body));
			const create = api.calls.find((call) => call.key === 'POST /api/v1/jobs/createTask');
			assert.equal(create.options.body.input.image_url, `spicy://f/fil_${attempt}`);
			assert.equal(create.options.qs, undefined, 'video skips the server-side wait');
			assert.equal(out[0].json.taskId, 'job_v');
			keys.push(create.options.headers['Idempotency-Key']);
		}
		// Different URIs, same bytes: the key stays the same, so SpicyAPI can tell it is a resend.
		assert.equal(keys[0], keys[1]);
	});

	it('reports a missing required file before spending anything', async () => {
		const api = fakeApi({ [`GET /api/v1/models/${I2V}`]: [modelResponse(I2V)] });
		const params = {
			resource: 'video',
			operation: 'generate',
			model: { mode: 'id', value: I2V },
			prompt: 'x',
			mediaInputs: {},
			modelParameters: { mappingMode: 'defineBelow', value: {}, schema: [] },
			additionalParameters: '{}',
			maxCost: 2,
			generateOptions: {},
		};
		await assert.rejects(runNode(fakeExecuteContext({ params, api })), /needs 'image_url'/);
		assert.equal(api.calls.length, 1);
	});

	it('turns a failed task into an error that names the task, or an item with continueOnFail', async () => {
		const failed = {
			taskId: 'job_f',
			state: 'failed',
			errorCode: 'content_rejected',
			errorMessage: 'Declined',
		};
		const routes = () => ({
			[`GET /api/v1/models/${T2I}`]: [modelResponse(T2I)],
			'POST /api/v1/jobs/quote': [response(200, envelope({ quoteId: 'q', estimatedCost: '0.01' }))],
			'POST /api/v1/jobs/createTask': [response(200, envelope(failed))],
		});
		await assert.rejects(
			runNode(fakeExecuteContext({ params: imageParams(), api: fakeApi(routes()) })),
			(error) => {
				assert.match(error.message, /content_rejected: Declined/);
				assert.match(error.description, /nothing was charged/);
				assert.match(error.description, /job_f/);
				return true;
			},
		);
		const [items] = await runNode(
			fakeExecuteContext({ params: imageParams(), api: fakeApi(routes()), continueOnFail: true }),
		);
		assert.equal(items[0].json.taskId, 'job_f');
		assert.match(items[0].json.error, /content_rejected/);
	});
});

describe('Chat', () => {
	it('sends an OpenAI-shaped request with a deterministic key and simplifies the answer', async () => {
		const api = fakeApi({
			'POST /v1/chat/completions': [
				response(
					200,
					{
						model: 'deepseek/v4.1-flash/chat',
						choices: [
							{
								message: { role: 'assistant', content: 'Fresh beans, slow mornings.' },
								finish_reason: 'stop',
							},
						],
						usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
					},
					{ 'x-spicy-task-id': 'job_c', 'x-spicy-ignored-params': 'top_k, min_p' },
				),
			],
		});
		const params = {
			resource: 'chat',
			operation: 'message',
			model: { mode: 'list', value: 'deepseek/v4.1-flash/chat' },
			chatPrompt: 'Write a tagline for a coffee shop',
			simplifyOutput: true,
			chatOptions: { systemMessage: 'Be brief.', maxTokens: 64, additionalBody: '{"top_k": 20}' },
		};
		const [items] = await runNode(fakeExecuteContext({ params, api }));
		const call = api.calls[0];
		assert.deepEqual(call.options.body, {
			model: 'deepseek/v4.1-flash/chat',
			messages: [
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: 'Write a tagline for a coffee shop' },
			],
			max_tokens: 64,
			top_k: 20,
		});
		assert.match(call.options.headers['Idempotency-Key'], /^n8n-[0-9a-f]{64}$/);
		assert.deepEqual(items[0].json, {
			text: 'Fresh beans, slow mornings.',
			model: 'deepseek/v4.1-flash/chat',
			finishReason: 'stop',
			usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
			taskId: 'job_c',
			ignoredParams: ['top_k', 'min_p'],
		});
	});
});

describe('Package metadata', () => {
	it('keeps the User-Agent version in step with package.json', () => {
		const { PACKAGE_VERSION } = require('../dist/nodes/SpicyapiAi/shared/constants.js');
		assert.equal(PACKAGE_VERSION, require('../package.json').version);
	});

	it('uses a credential name that cannot collide with other SpicyAPI-named packages', () => {
		const { SpicyapiAiApi } = require('../dist/credentials/SpicyapiAiApi.credentials.js');
		const credential = new SpicyapiAiApi();
		assert.equal(credential.name, 'spicyapiAiApi');
		assert.notEqual(credential.name, 'spicyApi');
	});
});
