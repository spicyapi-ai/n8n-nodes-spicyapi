/** Amounts arrive as decimal strings in US dollars ("0.012"). */
export function parseUsd(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** "$0.012", "$1.50": enough decimals to show sub-cent prices without trailing noise. */
export function formatUsd(value: unknown): string {
	const amount = parseUsd(value);
	if (amount === undefined) {
		return 'an unknown amount';
	}
	if (amount >= 1) {
		return `$${amount.toFixed(2)}`;
	}
	const fixed = amount.toFixed(6).replace(/0+$/, '');
	const [whole, decimals = ''] = fixed.split('.');
	return `$${whole}.${decimals.padEnd(2, '0')}`;
}

export interface QuoteLike {
	estimatedCost?: unknown;
	maxCharge?: unknown;
	quoteId?: unknown;
}

/** The most this request can cost: maxCharge when present, otherwise the estimate. */
export function quoteCeiling(quote: QuoteLike): number | undefined {
	return parseUsd(quote.maxCharge) ?? parseUsd(quote.estimatedCost);
}

export type QuoteCheck =
	| { ok: true; ceiling?: number }
	| { ok: false; ceiling: number; message: string };

/**
 * Compare a quote with the per-item limit before anything is created. A limit of 0 (or less)
 * means "no limit". A quote without any amount is treated as over the limit when a limit is set:
 * the guard exists to stop unexpected spend, so it fails closed.
 */
export function checkQuoteLimit(quote: QuoteLike, maxCostUsd: number): QuoteCheck {
	const ceiling = quoteCeiling(quote);
	if (!(maxCostUsd > 0)) {
		return { ok: true, ceiling };
	}
	if (ceiling === undefined) {
		return {
			ok: false,
			ceiling: Number.NaN,
			message:
				'SpicyAPI did not return a price for this request, so the cost limit could not be checked. Nothing was charged.',
		};
	}
	// Compare in micro-dollars so float noise in the last digit never decides the outcome.
	if (Math.round(ceiling * 1e6) > Math.round(maxCostUsd * 1e6)) {
		return {
			ok: false,
			ceiling,
			message: `This item could cost up to ${formatUsd(ceiling)}, above the limit of ${formatUsd(
				maxCostUsd,
			)} per item. Nothing was charged.`,
		};
	}
	return { ok: true, ceiling };
}
