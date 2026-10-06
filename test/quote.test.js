'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { dist } = require('./helpers');
const { checkQuoteLimit, formatUsd, parseUsd, quoteCeiling } = require(
	dist('nodes', 'SpicyapiAi', 'shared', 'quote.js'),
);

describe('checkQuoteLimit', () => {
	it('passes a quote under the limit', () => {
		assert.deepEqual(checkQuoteLimit({ estimatedCost: '0.01', maxCharge: '0.01' }, 2), {
			ok: true,
			ceiling: 0.01,
		});
	});

	it('passes a quote exactly at the limit', () => {
		assert.equal(checkQuoteLimit({ estimatedCost: '2', maxCharge: '2.000000' }, 2).ok, true);
	});

	it('stops a quote above the limit and says nothing was charged', () => {
		const result = checkQuoteLimit({ estimatedCost: '2.4', maxCharge: '2.4' }, 2);
		assert.equal(result.ok, false);
		assert.match(result.message, /\$2\.40/);
		assert.match(result.message, /\$2\.00/);
		assert.match(result.message, /Nothing was charged/);
	});

	it('uses maxCharge over estimatedCost when both are present', () => {
		assert.equal(checkQuoteLimit({ estimatedCost: '1.5', maxCharge: '2.5' }, 2).ok, false);
		assert.equal(quoteCeiling({ estimatedCost: '1.5', maxCharge: '2.5' }), 2.5);
	});

	it('falls back to estimatedCost when maxCharge is missing', () => {
		assert.equal(checkQuoteLimit({ estimatedCost: '3' }, 2).ok, false);
		assert.equal(checkQuoteLimit({ estimatedCost: '0.5' }, 2).ok, true);
	});

	it('treats a limit of 0 as no limit', () => {
		assert.equal(checkQuoteLimit({ estimatedCost: '250' }, 0).ok, true);
	});

	it('fails closed when a limit is set but the quote has no price', () => {
		const result = checkQuoteLimit({}, 2);
		assert.equal(result.ok, false);
		assert.match(result.message, /could not be checked/);
	});

	it('is not fooled by floating point noise at the limit', () => {
		assert.equal(checkQuoteLimit({ estimatedCost: String(0.1 + 0.2) }, 0.3).ok, true);
	});
});

describe('formatUsd and parseUsd', () => {
	it('formats sub-cent and whole-dollar amounts', () => {
		assert.equal(formatUsd('0.012'), '$0.012');
		assert.equal(formatUsd('0.001816'), '$0.001816');
		assert.equal(formatUsd('0.5'), '$0.50');
		assert.equal(formatUsd(2), '$2.00');
		assert.equal(formatUsd('0'), '$0.00');
	});

	it('parses decimal strings and rejects junk', () => {
		assert.equal(parseUsd('0.25'), 0.25);
		assert.equal(parseUsd(''), undefined);
		assert.equal(parseUsd('abc'), undefined);
		assert.equal(parseUsd(null), undefined);
	});
});
