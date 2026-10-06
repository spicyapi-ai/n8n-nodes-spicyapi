import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Credential for SpicyAPI (spicyapi.ai). The name is deliberately not "spicyApi": n8n registers
 * credential types by their bare name across all installed packages, and an unrelated package
 * already uses that one.
 */
export class SpicyapiAiApi implements ICredentialType {
	name = 'spicyapiAiApi';

	displayName = 'SpicyAPI (spicyapi.ai) API';

	icon: Icon = {
		light: 'file:../nodes/SpicyapiAi/spicyapi.svg',
		dark: 'file:../nodes/SpicyapiAi/spicyapi.dark.svg',
	};

	documentationUrl = 'https://github.com/spicyapi-ai/n8n-nodes-spicyapi#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'A key from https://spicyapi.ai/console/keys. It starts with sk-spicy-.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.spicyapi.ai',
			description: 'Leave as is unless SpicyAPI support tells you otherwise',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/chat/credit',
			method: 'GET',
		},
	};
}
