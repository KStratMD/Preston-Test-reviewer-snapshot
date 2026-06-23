/**
 * Shared Data Normalization Utilities
 * 
 * Common normalization, comparison, and fuzzy matching functions used by
 * both AIFieldMappingService and MDM EntityMatchingService.
 */

/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Fuzzy string comparison using Levenshtein distance
 * Returns similarity score 0-1 (1 = identical)
 */
export function fuzzyCompare(a: string, b: string): number {
    const strA = (a || '').toLowerCase().trim();
    const strB = (b || '').toLowerCase().trim();

    const maxLen = Math.max(strA.length, strB.length);
    if (maxLen === 0) return 1;

    const distance = levenshteinDistance(strA, strB);
    return 1 - (distance / maxLen);
}

/**
 * Normalize phone number to digits only
 * Handles international prefixes and common formats
 *
 * Note: Currently optimized for US/NANP phone numbers.
 * For international numbers, returns raw digits without country code normalization.
 */
export function normalizePhone(phone: string | null | undefined): string {
    if (!phone) return '';

    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');

    // Remove leading 1 for US/NANP numbers (11 digits starting with 1)
    if (digits.length === 11 && digits.startsWith('1')) {
        return digits.slice(1);
    }

    return digits;
}

/**
 * Compare two phone numbers
 * Returns similarity score 0-1
 */
export function comparePhones(a: string | null | undefined, b: string | null | undefined): number {
    const normA = normalizePhone(a);
    const normB = normalizePhone(b);

    if (!normA && !normB) return 1;
    if (!normA || !normB) return 0;

    if (normA === normB) return 1;

    // Match on last 10 digits (handles with/without country code)
    if (normA.slice(-10) === normB.slice(-10) && normA.length >= 10 && normB.length >= 10) {
        return 0.95;
    }

    // Match on last 7 digits (local number without area code)
    if (normA.slice(-7) === normB.slice(-7) && normA.length >= 7 && normB.length >= 7) {
        return 0.8;
    }

    return fuzzyCompare(normA, normB);
}

/**
 * Normalize email address
 * Lowercase, trim, and optionally remove plus addressing
 */
export function normalizeEmail(email: string | null | undefined, options?: { removePlusAddressing?: boolean }): string {
    if (!email) return '';

    let normalized = email.toLowerCase().trim();

    // Remove plus addressing (e.g., user+tag@example.com → user@example.com)
    if (options?.removePlusAddressing) {
        normalized = normalized.replace(/\+[^@]+@/, '@');
    }

    return normalized;
}

/**
 * Compare two email addresses
 * Returns similarity score 0-1
 */
export function compareEmails(a: string | null | undefined, b: string | null | undefined): number {
    const normA = normalizeEmail(a);
    const normB = normalizeEmail(b);

    if (!normA && !normB) return 1;
    if (!normA || !normB) return 0;

    if (normA === normB) return 1;

    // Same domain, similar local part
    const [localA, domainA] = normA.split('@');
    const [localB, domainB] = normB.split('@');

    if (domainA === domainB) {
        const localSimilarity = fuzzyCompare(localA, localB);
        return 0.5 + (localSimilarity * 0.5); // 50-100% if same domain
    }

    return fuzzyCompare(normA, normB) * 0.8; // Cap at 80% for different domains
}

/**
 * Normalize address for comparison
 * Standardizes common abbreviations and formats
 */
export function normalizeAddress(address: string | null | undefined): string {
    if (!address) return '';

    let normalized = address.toLowerCase().trim();

    // Standard abbreviations
    const replacements: [RegExp, string][] = [
        [/\bstreet\b/g, 'st'],
        [/\bavenue\b/g, 'ave'],
        [/\bboulevard\b/g, 'blvd'],
        [/\bdrive\b/g, 'dr'],
        [/\bplace\b/g, 'pl'],
        [/\broad\b/g, 'rd'],
        [/\bcourt\b/g, 'ct'],
        [/\blane\b/g, 'ln'],
        [/\bsuite\b/g, 'ste'],
        [/\bapartment\b/g, 'apt'],
        [/\bbuilding\b/g, 'bldg'],
        [/\bnorth\b/g, 'n'],
        [/\bsouth\b/g, 's'],
        [/\beast\b/g, 'e'],
        [/\bwest\b/g, 'w'],
        [/\bnorthwest\b/g, 'nw'],
        [/\bnortheast\b/g, 'ne'],
        [/\bsouthwest\b/g, 'sw'],
        [/\bsoutheast\b/g, 'se'],
    ];

    for (const [pattern, replacement] of replacements) {
        normalized = normalized.replace(pattern, replacement);
    }

    // Remove extra whitespace and punctuation
    normalized = normalized.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    return normalized;
}

/**
 * Compare two addresses
 * Returns similarity score 0-1
 */
export function compareAddresses(a: string | null | undefined, b: string | null | undefined): number {
    const normA = normalizeAddress(a);
    const normB = normalizeAddress(b);

    if (!normA && !normB) return 1;
    if (!normA || !normB) return 0;

    if (normA === normB) return 1;

    // Check if one contains the other (handles Bldg A, Suite 100, etc.)
    if (normA.includes(normB) || normB.includes(normA)) {
        return 0.9;
    }

    return fuzzyCompare(normA, normB);
}

/**
 * Normalize company/business name for comparison
 */
export function normalizeCompanyName(name: string | null | undefined): string {
    if (!name) return '';

    let normalized = name.toLowerCase().trim();

    // Remove common suffixes
    const suffixes = [
        /\b(inc|incorporated)\.?$/,
        /\b(llc|l\.l\.c\.)$/,
        /\b(ltd|limited)\.?$/,
        /\b(corp|corporation)\.?$/,
        /\b(co|company)\.?$/,
        /\b(plc)$/,
        /\b(gmbh)$/,
        /\b(ag)$/,
    ];

    for (const suffix of suffixes) {
        normalized = normalized.replace(suffix, '');
    }

    // Remove "the" prefix
    normalized = normalized.replace(/^the\s+/, '');

    // Remove extra whitespace and punctuation
    normalized = normalized.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    return normalized;
}

/**
 * Compare two company names
 * Returns similarity score 0-1
 */
export function compareCompanyNames(a: string | null | undefined, b: string | null | undefined): number {
    const normA = normalizeCompanyName(a);
    const normB = normalizeCompanyName(b);

    if (!normA && !normB) return 1;
    if (!normA || !normB) return 0;

    if (normA === normB) return 1;

    // Check for acronym match (e.g., "IBM" vs "International Business Machines")
    const wordsA = normA.split(/\s+/);
    const wordsB = normB.split(/\s+/);

    if (wordsA.length === 1 && wordsB.length > 1) {
        const acronym = wordsB.map(w => w[0]).join('');
        if (normA === acronym) return 0.85;
    }
    if (wordsB.length === 1 && wordsA.length > 1) {
        const acronym = wordsA.map(w => w[0]).join('');
        if (normB === acronym) return 0.85;
    }

    return fuzzyCompare(normA, normB);
}

/**
 * Detect the data type/pattern of a value
 */
export function detectDataPattern(value: unknown): {
    type: 'email' | 'phone' | 'date' | 'currency' | 'number' | 'boolean' | 'identifier' | 'text' | 'unknown';
    confidence: number;
} {
    if (value === null || value === undefined) {
        return { type: 'unknown', confidence: 0 };
    }

    if (typeof value === 'boolean') {
        return { type: 'boolean', confidence: 1 };
    }

    if (typeof value === 'number') {
        return { type: 'number', confidence: 1 };
    }

    const str = String(value).trim();

    // Boolean strings
    if (/^(true|false|yes|no|y|n|0|1)$/i.test(str)) {
        return { type: 'boolean', confidence: 0.9 };
    }

    // Email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        return { type: 'email', confidence: 0.95 };
    }

    // Phone (various formats)
    const digitsOnly = str.replace(/\D/g, '');
    if (/^[\d\s\-\(\)\+\.]{7,20}$/.test(str) && digitsOnly.length >= 7 && digitsOnly.length <= 15) {
        return { type: 'phone', confidence: 0.85 };
    }

    // Currency - matches $100, $1,000, $99.99, etc.
    // Requires $ prefix OR decimal point to distinguish from plain numbers
    if (/^\$[\d,]+\.?\d{0,2}$/.test(str) || /^[\d,]+\.\d{2}$/.test(str)) {
        return { type: 'currency', confidence: 0.8 };
    }

    // Date (ISO, common formats)
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(str) || /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(str)) {
        return { type: 'date', confidence: 0.9 };
    }

    // Identifier (SKU, ID patterns) - 0.75 confidence because alphanumeric patterns
    // can also match other types (e.g., "ABC123" could be an ID or abbreviation)
    if (/^[A-Z0-9\-_]{3,20}$/i.test(str) && /[A-Z]/.test(str) && /\d/.test(str)) {
        return { type: 'identifier', confidence: 0.75 };
    }

    // Number
    if (/^-?[\d,]+\.?\d*$/.test(str.replace(/,/g, ''))) {
        return { type: 'number', confidence: 0.8 };
    }

    // Default to text
    return { type: 'text', confidence: 0.5 };
}

/**
 * Get nested field value from an object using dot notation
 */
export function getNestedValue(data: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let value: unknown = data;

    for (const part of parts) {
        if (value && typeof value === 'object') {
            value = (value as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }

    return value;
}

/**
 * Score to confidence level conversion
 */
export function scoreToConfidence(score: number): 'low' | 'medium' | 'high' {
    if (score >= 0.9) return 'high';
    if (score >= 0.75) return 'medium';
    return 'low';
}
