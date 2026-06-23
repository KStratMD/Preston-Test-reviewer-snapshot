#!/usr/bin/env node
// @ts-check
//
// M1 Phase A (+ Phase B widening): AI accuracy benchmark harness.
//
// Reads labeled fixtures (`scripts/golden/fixtures/*.yaml`), runs each
// case against an AI provider, and computes top-1 accuracy + a
// hallucination count. Writes two artifacts:
//   - `docs/review/ai-accuracy-benchmark.json` — machine-readable summary
//   - `docs/review/ai-accuracy-benchmark.md`   — human-readable rendering
//
// Both pull from the same in-memory result object so the accuracy number
// is identical across formats.
//
// Modes:
//   --dry-run        Deterministic mock provider (oracle returns labeled
//                    answer). Used by CI / drift tests; no API call, $0.
//   --matrix         Full provider × pair cross-product: [openai, anthropic]
//                    × [SFDC→NS customers, SFDC→BC customers] = 4 cells,
//                    per-provider default models. Incompatible with
//                    --provider/--model/--fixture. Composable with --dry-run.
//   --include-provider <openrouter|lmstudio>
//                    Opt-in extra matrix providers (repeatable; requires
//                    --matrix). Both reuse the OpenAI-compatible chat
//                    completions call path. OpenRouter: pinned `:free`
//                    default model ($0), requires OPENROUTER_API_KEY.
//                    LMStudio: local inference ($0), model discovered from
//                    `GET <base>/v1/models` at run start, base URL from
//                    LMSTUDIO_BASE_URL with the same WSL-gateway fallback
//                    as src/services/ai/utils/lmstudio.ts.
//   (default)        Live single run. `--provider openai` (default;
//                    default model gpt-5.4-mini, requires OPENAI_API_KEY),
//                    `--provider anthropic` (default model claude-haiku-4-5,
//                    requires ANTHROPIC_API_KEY), `--provider openrouter`,
//                    or `--provider lmstudio`. Pass `--model <name>` (must
//                    be priced for openai/anthropic; must end `:free` for
//                    openrouter) to override.
//                    Honors MAX_BENCHMARK_COST_USD (default $5) — a single
//                    cap for the whole invocation: runner refuses to start
//                    if the worst-case estimate summed over ALL cells
//                    exceeds the cap AND aborts mid-run on the iteration
//                    whose actual cumulative cost (across cells) would
//                    cross it. OpenRouter (:free) and LMStudio cells are
//                    $0 by construction and never contribute to the cap.
//
// Phase B scope (relaxed from Phase A; A/C follow-ups 2026-06):
//   - Two ERP pairs:  SFDC → NS customers + SFDC → BC customers.
//   - Two providers:  OpenAI + Anthropic; `--matrix` runs all 4 cells.
//                     OpenRouter + LMStudio are OPT-IN extra cells via
//                     --include-provider (never part of the default matrix
//                     or the canonical headline).
//   - Metrics:        top-1 accuracy + Wilson 95% CI + hallucination count
//                     (no self-consistency yet).
//   - Manual only;    no nightly smoke.
//
// Artifact: schema_version 3 in BOTH modes — the v1 top-level headline
// fields are preserved (mirroring the canonical run = openai ×
// sfdc-to-ns-customers; in single-run mode = that run itself) plus a
// per-cell `runs: [...]` array and `total_estimated_cost_usd`. v3 adds
// `accuracy_top1_ci95` (Wilson score interval) per run + headline mirror.
//
// Data-leakage guard: NONE of the (sourceField, targetField) pairs in the
// fixture may match COMMON_MAPPING_EXAMPLES from
// src/services/ai/prompts/FieldMappingPrompts.ts. If the live prompt supplies
// target schema context, it must be a broad schema with real distractors, not
// the fixture's target answer-set. The runner refuses to proceed on pair
// overlap; the unit test also guards the prompt vocabulary surface.

import fs from 'node:fs';
import { release as osRelease } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Mirror of `src/services/ai/prompts/FieldMappingPrompts.ts`
// COMMON_MAPPING_EXAMPLES at (sourceField, targetField) granularity. Used
// for the data-leakage refusal. Kept in sync by the unit test:
// `tests/unit/scripts/run-ai-accuracy-benchmark.dataLeakage.test.ts`.
const COMMON_EXAMPLE_PAIRS = [
  ['customer_email', 'email'],
  ['full_name', 'firstName'],
  ['firstName', 'fullName'],
  ['account_id', 'entityId'],
  ['phone_number', 'phone'],
  ['created_date', 'createdAt'],
  ['F1rst Name', 'firstName'],
  ['cmpny_name', 'companyName'],
  ['ph#', 'phone'],
  ['billing_address', 'billingAddress'],
  ['shipping_address', 'shippingAddress'],
  ['street', 'fullAddress'],
];

// Broad NetSuite Customer schema context, using the benchmark's existing
// SuiteTalk-style camelCase target naming. Source basis: Oracle NetSuite
// Records Browser 2024.2 Customer record (`script/record/customer.html`) plus
// Customer address/search surface aliases that production mappings commonly
// expose. Keep this intentionally wider than the fixture labels: the benchmark
// may provide target schema context, but must not provide the answer-set.
const NETSUITE_CUSTOMER_SCHEMA_FIELDS = Object.freeze([
  { id: 'accessRole', label: 'Role' },
  { id: 'accountNumber', label: 'Account' },
  { id: 'address', label: 'Address' },
  { id: 'addressee', label: 'Addressee' },
  { id: 'addressInternalId', label: 'Address Internal ID' },
  { id: 'addressLabel', label: 'Address Label' },
  { id: 'addressPhone', label: 'Address Phone' },
  { id: 'alcoholRecipientType', label: 'Alcohol Recipient Type' },
  { id: 'altEmail', label: 'Alt. Email' },
  { id: 'altName', label: 'Name' },
  { id: 'altPhone', label: 'Alt. Phone' },
  { id: 'annualRevenue', label: 'Annual Revenue' },
  { id: 'assignedWebSite', label: 'Assigned Web Site' },
  { id: 'attention', label: 'Attention' },
  { id: 'autoName', label: 'Auto' },
  { id: 'balance', label: 'Balance' },
  { id: 'billAddressee', label: 'Billing Addressee' },
  { id: 'billAddr1', label: 'Billing Address 1' },
  { id: 'billAddr2', label: 'Billing Address 2' },
  { id: 'billAddr3', label: 'Billing Address 3' },
  { id: 'billAttention', label: 'Billing Attention' },
  { id: 'billCity', label: 'Billing City' },
  { id: 'billCountry', label: 'Billing Country' },
  { id: 'billPhone', label: 'Billing Phone' },
  { id: 'billState', label: 'Billing State/Province' },
  { id: 'billZip', label: 'Billing Zip' },
  { id: 'billingSchedule', label: 'Billing Schedule' },
  { id: 'billingTransactionForm', label: 'Billing Transaction Form' },
  { id: 'billingTransactionType', label: 'Billing Transaction Type' },
  { id: 'billPay', label: 'Enable Online Bill Pay' },
  { id: 'buyingReason', label: 'Buying Reason' },
  { id: 'buyingTimeFrame', label: 'Buying Time Frame' },
  { id: 'campaignCategory', label: 'Campaign Category' },
  { id: 'category', label: 'Category' },
  { id: 'city', label: 'City' },
  { id: 'clickStream', label: 'Clickstream (1st Visit)' },
  { id: 'comments', label: 'Comments' },
  { id: 'companyName', label: 'Company Name' },
  { id: 'consolBalance', label: 'Consolidated Balance' },
  { id: 'consolDaysOverdue', label: 'Consolidated Days Overdue' },
  { id: 'consolDepositBalance', label: 'Consolidated Deposit Balance' },
  { id: 'consolOverdueBalance', label: 'Consolidated Overdue Balance' },
  { id: 'consolUnbilledOrders', label: 'Consolidated Unbilled Orders' },
  { id: 'contact', label: 'Primary Contact' },
  { id: 'contribution', label: 'Contribution %' },
  { id: 'contributionPrimary', label: 'Primary Sales Rep Contribution %' },
  { id: 'conversionDate', label: 'Conversion Date' },
  { id: 'country', label: 'Country' },
  { id: 'creditHoldOverride', label: 'Credit Hold Override' },
  { id: 'creditLimit', label: 'Credit Limit' },
  { id: 'currency', label: 'Currency' },
  { id: 'currencyPrecision', label: 'Currency Precision' },
  { id: 'customForm', label: 'Custom Form' },
  { id: 'dateClosed', label: 'Date Closed' },
  { id: 'dateCreated', label: 'Date Created' },
  { id: 'daysOverdue', label: 'Days Overdue' },
  { id: 'defaultAddress', label: 'Address' },
  { id: 'defaultAllocationStrategy', label: 'Default Allocation Strategy' },
  { id: 'defaultBankAccount', label: 'Bank Account' },
  { id: 'defaultOrderPriority', label: 'Default Order Priority' },
  { id: 'defaultTaxReg', label: 'Default Tax Reg.' },
  { id: 'depositBalance', label: 'Deposit Balance' },
  { id: 'displaySymbol', label: 'Currency Symbol' },
  { id: 'drAccount', label: 'Deferred Revenue Reclassification Account' },
  { id: 'email', label: 'Email' },
  { id: 'emailPreference', label: 'Email Preference' },
  { id: 'emailTransactions', label: 'Email Transactions' },
  { id: 'endDate', label: 'End Date' },
  { id: 'entityId', label: 'Customer ID' },
  { id: 'entityNumber', label: 'Number' },
  { id: 'entityStatus', label: 'Status' },
  { id: 'estimatedBudget', label: 'Estimated Budget' },
  { id: 'externalId', label: 'External ID' },
  { id: 'fax', label: 'Fax' },
  { id: 'faxTransactions', label: 'Fax Transactions' },
  { id: 'firstName', label: 'First Name' },
  { id: 'firstOrderDate', label: 'Date of First Order' },
  { id: 'firstSaleDate', label: 'Date of First Sale' },
  { id: 'firstVisit', label: 'Date of First Visit' },
  { id: 'fxAccount', label: 'Foreign Currency Adjustment Revenue Account' },
  { id: 'giveAccess', label: 'Give Access' },
  { id: 'globalSubscriptionStatus', label: 'Global Subscription Status' },
  { id: 'groupPricingLevel', label: 'Group Pricing Level' },
  { id: 'hasDuplicates', label: 'Duplicate' },
  { id: 'homePhone', label: 'Home Phone' },
  { id: 'image', label: 'Image' },
  { id: 'industry', label: 'Industry' },
  { id: 'internalId', label: 'Internal ID' },
  { id: 'isBudgetApproved', label: 'Budget Approved' },
  { id: 'isInactive', label: 'Inactive' },
  { id: 'isJob', label: 'Is Job' },
  { id: 'isPerson', label: 'Is Individual' },
  { id: 'itemPriceLevel', label: 'Item Pricing Level' },
  { id: 'itemPricingUnitPrice', label: 'Item Pricing Unit Price' },
  { id: 'keywords', label: 'Search Engine Keywords (1st Visit)' },
  { id: 'language', label: 'Language' },
  { id: 'lastModifiedDate', label: 'Last Modified Date' },
  { id: 'lastName', label: 'Last Name' },
  { id: 'lastOrderDate', label: 'Date of Last Order' },
  { id: 'lastPageVisited', label: 'Last Page Visited' },
  { id: 'lastSaleDate', label: 'Date of Last Sale' },
  { id: 'lastViewed', label: 'Last Viewed' },
  { id: 'lastVisit', label: 'Date of Last Visit' },
  { id: 'leadDate', label: 'Lead Date' },
  { id: 'leadSource', label: 'Lead Source' },
  { id: 'level', label: 'Level' },
  { id: 'manualCreditHold', label: 'Manual Credit Hold' },
  { id: 'middleName', label: 'Middle Name' },
  { id: 'mobilePhone', label: 'Mobile Phone' },
  { id: 'monthlyClosing', label: 'Monthly Closing Date' },
  { id: 'negativeNumberFormat', label: 'Negative Number Format' },
  { id: 'numberFormat', label: 'Number Format' },
  { id: 'numberOfEmployees', label: 'Number of Employees' },
  { id: 'onCreditHold', label: 'On Credit Hold' },
  { id: 'openingBalance', label: 'Opening Balance' },
  { id: 'openingBalanceAccount', label: 'Opening Balance Account' },
  { id: 'openingBalanceDate', label: 'Opening Balance Date' },
  { id: 'overdueBalance', label: 'Overdue Balance' },
  { id: 'parent', label: 'Child Of' },
  { id: 'parentName', label: 'Parent Customer Name' },
  { id: 'partner', label: 'Partner' },
  { id: 'partnerContribution', label: 'Partner Contribution %' },
  { id: 'partnerRole', label: 'Partner Role' },
  { id: 'partnerTeamMember', label: 'Partner Team Member' },
  { id: 'password', label: 'Password' },
  { id: 'password2', label: 'Confirm Password' },
  { id: 'pec', label: 'PEC' },
  { id: 'permission', label: 'Permission' },
  { id: 'phone', label: 'Phone' },
  { id: 'phoneticName', label: 'Phonetic Name' },
  { id: 'prefCCProcessor', label: 'Preferred Credit Card Processor' },
  { id: 'priceLevel', label: 'Price Level' },
  { id: 'pricingGroup', label: 'Pricing Group' },
  { id: 'pricingItem', label: 'Pricing Item' },
  { id: 'printOnCheckAs', label: 'Print on Check As' },
  { id: 'printTransactions', label: 'Print Transactions' },
  { id: 'prospectDate', label: 'Prospect Date' },
  { id: 'receivablesAccount', label: 'Default Receivables Account' },
  { id: 'referrer', label: 'Referrer (1st Visit)' },
  { id: 'reminderDays', label: 'Reminder Days' },
  { id: 'representingSubsidiary', label: 'Represents Subsidiary' },
  { id: 'resaleNumber', label: 'Resale Number' },
  { id: 'role', label: 'Role' },
  { id: 'salesGroup', label: 'Choose Team' },
  { id: 'salesRating', label: 'Sales Rating' },
  { id: 'salesReadiness', label: 'Sales Readiness' },
  { id: 'salesRep', label: 'Sales Rep' },
  { id: 'salesRepName', label: 'Sales Rep Name' },
  { id: 'salesTeamMember', label: 'Sales Team Member' },
  { id: 'salesTeamRole', label: 'Sales Team Role' },
  { id: 'salutation', label: 'Mr./Ms.' },
  { id: 'sendEmail', label: 'Send Notification Email' },
  { id: 'shipAddressee', label: 'Shipping Addressee' },
  { id: 'shipAddr1', label: 'Shipping Address 1' },
  { id: 'shipAddr2', label: 'Shipping Address 2' },
  { id: 'shipAddr3', label: 'Shipping Address 3' },
  { id: 'shipAttention', label: 'Shipping Attention' },
  { id: 'shipCity', label: 'Shipping City' },
  { id: 'shipComplete', label: 'Ship Complete' },
  { id: 'shipCountry', label: 'Shipping Country' },
  { id: 'shipPhone', label: 'Shipping Phone' },
  { id: 'shipState', label: 'Shipping State/Province' },
  { id: 'shipZip', label: 'Shipping Zip' },
  { id: 'shippingCarrier', label: 'Shipping Carrier' },
  { id: 'shippingItem', label: 'Shipping Item' },
  { id: 'sourceWebSite', label: 'Source Web Site' },
  { id: 'stage', label: 'Stage' },
  { id: 'startDate', label: 'Start Date' },
  { id: 'state', label: 'State/Province' },
  { id: 'strength', label: 'Password Strength' },
  { id: 'subsidiary', label: 'Subsidiary' },
  { id: 'subsidiaryNoHierarchy', label: 'Subsidiary (no hierarchy)' },
  { id: 'syncPartnerTeams', label: 'Update Partner Team Transactions' },
  { id: 'syncSalesTeams', label: 'Update Sales Team Transactions' },
  { id: 'taxable', label: 'Taxable' },
  { id: 'taxExempt', label: 'PST Exempt' },
  { id: 'taxFractionUnit', label: 'Tax Rounding Precision' },
  { id: 'taxIdNum', label: 'Tax ID Number' },
  { id: 'taxItem', label: 'Tax Item' },
  { id: 'taxRounding', label: 'Tax Rounding Method' },
  { id: 'terms', label: 'Terms' },
  { id: 'territory', label: 'Territory' },
  { id: 'thirdPartyAcct', label: '3rd Party Billing Account Number' },
  { id: 'thirdPartyCarrier', label: '3rd Party Billing Carrier' },
  { id: 'thirdPartyCountry', label: '3rd Party Billing Country' },
  { id: 'thirdPartyZipCode', label: '3rd Party Billing Zip' },
  { id: 'title', label: 'Job Title' },
  { id: 'type', label: 'Entity Type' },
  { id: 'unbilledOrders', label: 'Unbilled Orders' },
  { id: 'unsubscribe', label: 'Unsubscribe from Campaigns' },
  { id: 'url', label: 'Web Address' },
  { id: 'vatRegNumber', label: 'Tax Registration Number' },
  { id: 'visits', label: 'Number of Visits' },
  { id: 'webLead', label: 'Web Lead' },
  { id: 'zipCode', label: 'Zip Code' },
]);

// Precomputed once — the schema is constant, so there's no need to rebuild
// this block on every callOpenAI() invocation.
const NETSUITE_CUSTOMER_SCHEMA_BLOCK = NETSUITE_CUSTOMER_SCHEMA_FIELDS
  .map((field) => `  - ${field.id}: ${field.label}`)
  .join('\n');

// Broad Business Central Customer schema context (Phase B, SFDC→BC pair).
// This is the COMPLETE real production schema: every scalar Property of the
// OData v4 customers EntityType in
// `src/connectors/fixtures/bc/metadata/customers.xml` (NavigationProperty
// elements excluded), uncurated relative to the fixture answer-set — exactly
// what production shows the model. Because the real schema is only ~19
// fields, the NS ">=75 absolute distractors" floor is replaced by a
// proportional rule: the BC fixture may label AT MOST floor(schema/2) = 9
// distinct targets, guaranteeing >=10 distractors (>=50%). Parity with the
// XML is pinned by
// `tests/unit/scripts/run-ai-accuracy-benchmark.dataLeakage.test.ts` so the
// candidate set can never be quietly curated.
const BC_CUSTOMER_SCHEMA_FIELDS = Object.freeze([
  { id: 'id', label: 'ID' },
  { id: 'displayName', label: 'Display Name' },
  { id: 'number', label: 'Number' },
  { id: 'email', label: 'Email' },
  { id: 'phoneNumber', label: 'Phone Number' },
  { id: 'website', label: 'Website' },
  { id: 'taxLiable', label: 'Tax Liable' },
  { id: 'taxAreaId', label: 'Tax Area ID' },
  { id: 'taxAreaDisplayName', label: 'Tax Area Display Name' },
  { id: 'taxRegistrationNumber', label: 'Tax Registration Number' },
  { id: 'currencyCode', label: 'Currency Code' },
  { id: 'paymentTermsId', label: 'Payment Terms ID' },
  { id: 'shipmentMethodId', label: 'Shipment Method ID' },
  { id: 'paymentMethodId', label: 'Payment Method ID' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'balance', label: 'Balance' },
  { id: 'overdueAmount', label: 'Overdue Amount' },
  { id: 'totalSalesExcludingTax', label: 'Total Sales Excluding Tax' },
  { id: 'lastModifiedDateTime', label: 'Last Modified Date Time' },
]);

const BC_CUSTOMER_SCHEMA_BLOCK = BC_CUSTOMER_SCHEMA_FIELDS
  .map((field) => `  - ${field.id}: ${field.label}`)
  .join('\n');

// Per-target-system prompt/schema context, keyed by `testSuite.targetSystem`
// in the fixture (loader defaults absent values to 'netsuite' for
// backward-compat). The NS values reproduce the original Phase A prompt
// byte-identically — do not reword them without re-checking the committed
// benchmark artifacts.
const TARGET_SYSTEM_CONTEXT = Object.freeze({
  netsuite: Object.freeze({
    displayName: 'NetSuite',
    recordLabel: 'NetSuite Customer',
    targetFieldPlaceholder: 'netsuite field',
    schemaFields: NETSUITE_CUSTOMER_SCHEMA_FIELDS,
    schemaBlock: NETSUITE_CUSTOMER_SCHEMA_BLOCK,
  }),
  businesscentral: Object.freeze({
    displayName: 'Business Central',
    recordLabel: 'Business Central Customer',
    targetFieldPlaceholder: 'business central field',
    schemaFields: BC_CUSTOMER_SCHEMA_FIELDS,
    schemaBlock: BC_CUSTOMER_SCHEMA_BLOCK,
  }),
});

function targetSystemContext(targetSystem) {
  const ctx = TARGET_SYSTEM_CONTEXT[targetSystem];
  if (!ctx) {
    const known = Object.keys(TARGET_SYSTEM_CONTEXT).join(', ');
    throw new Error(
      `Unknown testSuite.targetSystem "${targetSystem}" — pick one of: ${known}.`,
    );
  }
  return ctx;
}

const DEFAULT_FIXTURE = 'scripts/golden/fixtures/sfdc-to-ns-customers.yaml';
const BC_FIXTURE = 'scripts/golden/fixtures/sfdc-to-bc-customers.yaml';
const DEFAULT_JSON_OUT = 'docs/review/ai-accuracy-benchmark.json';
const DEFAULT_MD_OUT = 'docs/review/ai-accuracy-benchmark.md';
const SUPPORTED_PROVIDERS = Object.freeze(['openai', 'anthropic', 'openrouter', 'lmstudio']);
// --matrix cross-product: every BASE provider × every fixture, per-provider
// default models. The canonical cell (headline mirror) is
// CANONICAL_PROVIDER × CANONICAL_FIXTURE; it MUST be part of any matrix run.
// OpenRouter/LMStudio never join the base matrix — they are opt-in extra
// cells via --include-provider so the default invocation (and the committed
// canonical artifact) stays reproducible from the two paid keys alone.
const MATRIX_PROVIDERS = Object.freeze(['openai', 'anthropic']);
const OPTIONAL_MATRIX_PROVIDERS = Object.freeze(['openrouter', 'lmstudio']);
const MATRIX_FIXTURES = Object.freeze([DEFAULT_FIXTURE, BC_FIXTURE]);
const CANONICAL_PROVIDER = 'openai';
const CANONICAL_FIXTURE = DEFAULT_FIXTURE;
// LMStudio model sentinel: resolved against `GET <base>/v1/models` at run
// start in live mode (whatever model the local server has loaded); kept
// verbatim in --dry-run artifacts (no server contact on a $0 rehearsal).
const LMSTUDIO_MODEL_AUTO = 'auto';
const DEFAULT_MODEL_BY_PROVIDER = Object.freeze({
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5',
  // Pinned :free OpenRouter model — $0 by construction. Changing the pin is
  // fine, but the replacement MUST also be a `:free` variant (enforced in
  // parseArgs for --model and on the constructed cell list in main()) so
  // OpenRouter cells can never bill.
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
  lmstudio: LMSTUDIO_MODEL_AUTO,
});
// null = provider needs no API key (LMStudio is a local server).
const API_KEY_ENV_BY_PROVIDER = Object.freeze({
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  lmstudio: null,
});
// Providers whose cells cost $0 by construction (OpenRouter pinned to a
// `:free` model; LMStudio is local inference). They skip the pricing table
// entirely and never contribute to the MAX_BENCHMARK_COST_USD math.
const ZERO_COST_PROVIDERS = Object.freeze(new Set(['openrouter', 'lmstudio']));
const DEFAULT_MAX_COST_USD = 5.0;
// Shared completion-token budget per case. The paid providers cap the
// model's output identically so the comparison stays apples-to-apples.
const COMPLETION_TOKEN_BUDGET = 800;
// Zero-cost opt-in providers get a larger budget: local LM Studio models
// (and many :free OpenRouter models) are REASONING models whose thinking
// tokens bill against max_tokens — observed live (gemma-4-12b-qat): the
// whole 800 went to reasoning and content came back empty. The budget
// exists to bound cost/runaway, both moot at $0; what matters for
// comparability is the byte-identical prompt and an untruncated answer.
const ZERO_COST_COMPLETION_TOKEN_BUDGET = 4000;
// Per-request provider fetch timeout. A stalled or hung response would
// otherwise wedge the benchmark indefinitely; 60s is generous against
// observed latency (~2-5s per case) but short enough that
// an operator notices.
const PROVIDER_REQUEST_TIMEOUT_MS = 60_000;
// Per-model published rates (USD per 1K tokens) as of 2026-06. Used to
// refuse to start when the estimated cost exceeds MAX_BENCHMARK_COST_USD.
// Pessimistic — input AND output budgeted as 1K tokens / case for the
// cap check (real consumption is typically lower).
//
// Codex R3 finding: previously hardcoded to gpt-4o-mini rates. Passing
// `--model gpt-4o` then underestimated cost by ~17× (gpt-4o input is
// $0.0025 vs mini's $0.00015), letting a live run blow past the cap
// while the runner still claimed it was enforced. Per-model lookup
// fixes this; unknown models reject upfront rather than silently
// fall back to incorrect rates.
// Anthropic rates MUST stay equal to the canonical table in
// src/services/cost/modelPricing.ts — pinned by
// tests/unit/scripts/run-ai-accuracy-benchmark.pricingParity.test.ts.
const MODEL_PRICING_USD_PER_1K = Object.freeze({
  'gpt-5.4':      Object.freeze({ input: 0.0025,  output: 0.015 }),
  'gpt-5.4-mini': Object.freeze({ input: 0.00075, output: 0.0045 }),
  'gpt-5.4-nano': Object.freeze({ input: 0.0002,  output: 0.00125 }),
  'gpt-4o-mini': Object.freeze({ input: 0.00015, output: 0.0006 }),
  'gpt-4o':      Object.freeze({ input: 0.0025,  output: 0.01 }),
  'claude-haiku-4-5':          Object.freeze({ input: 0.001, output: 0.005 }),
  'claude-haiku-4-5-20251001': Object.freeze({ input: 0.001, output: 0.005 }),
});
function pricingForModel(model) {
  const rates = MODEL_PRICING_USD_PER_1K[model];
  if (!rates) {
    const known = Object.keys(MODEL_PRICING_USD_PER_1K).join(', ');
    throw new Error(
      `Unknown model "${model}" — no pricing rates on file. ` +
        `Add to MODEL_PRICING_USD_PER_1K (with the upstream-published rate) or pick one of: ${known}.`,
    );
  }
  return rates;
}

function openAICompletionTokenLimitParam(model, maxTokens) {
  return model.toLowerCase().startsWith('gpt-5')
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_FIXTURE,
    jsonOut: DEFAULT_JSON_OUT,
    mdOut: DEFAULT_MD_OUT,
    detailsOut: null,
    provider: 'openai',
    model: null, // resolved to the provider default below unless --model given
    matrix: false,
    // --include-provider opt-ins (openrouter/lmstudio)
    includeProviders: /** @type {string[]} */ ([]),
    dryRun: false,
    verbose: false,
  };
  // Track explicit cell-selection flags so --matrix can reject them: the
  // matrix IS the cell selection (full cross-product, per-provider default
  // models), so combining it with --provider/--model/--fixture is ambiguous.
  let providerExplicit = false;
  let modelExplicit = false;
  let fixtureExplicit = false;
  // Helper: read the next argv as the value for a value-taking flag, throw
  // if it's missing or starts with '-' (which would be the next flag, not a
  // value). Without this guard, passing `--fixture` as the final arg made
  // options.fixture become undefined and later path operations failed with
  // a confusing TypeError. Per Copilot review on PR #837.
  const takeValue = (flag, i) => {
    const v = argv[i];
    if (typeof v !== 'string' || v.startsWith('-')) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') options.dryRun = true;
    else if (a === '--matrix') options.matrix = true;
    else if (a === '--fixture') {
      options.fixture = takeValue('--fixture', ++i);
      fixtureExplicit = true;
    } else if (a === '--json-out') options.jsonOut = takeValue('--json-out', ++i);
    else if (a === '--md-out') options.mdOut = takeValue('--md-out', ++i);
    else if (a === '--details-out') options.detailsOut = takeValue('--details-out', ++i);
    else if (a === '--model') {
      options.model = takeValue('--model', ++i);
      modelExplicit = true;
    } else if (a === '--provider') {
      options.provider = takeValue('--provider', ++i);
      providerExplicit = true;
    } else if (a === '--include-provider') {
      const value = takeValue('--include-provider', ++i);
      if (!OPTIONAL_MATRIX_PROVIDERS.includes(value)) {
        const hint = MATRIX_PROVIDERS.includes(value)
          ? `"${value}" is always part of the base matrix — only opt-in providers go here.`
          : `Unknown provider "${value}".`;
        throw new Error(
          `--include-provider: ${hint} Pick one of: ${OPTIONAL_MATRIX_PROVIDERS.join(', ')}.`,
        );
      }
      // Repeats are harmless operator shorthand — dedupe rather than reject.
      if (!options.includeProviders.includes(value)) {
        options.includeProviders.push(value);
      }
    } else if (a === '--verbose') options.verbose = true;
    else if (a === '--help') {
      console.log(
        'Usage: node scripts/run-ai-accuracy-benchmark.mjs ' +
          '[--dry-run] [--matrix] [--include-provider openrouter|lmstudio]... [--fixture <path>] ' +
          '[--json-out <path>] [--md-out <path>] [--details-out <path>] ' +
          '[--provider openai|anthropic|openrouter|lmstudio] [--model <name>] [--verbose]\n\n' +
          '  --matrix     Run the full provider x pair cross-product (openai + anthropic\n' +
          '               x SFDC->NS + SFDC->BC = 4 cells) with per-provider default models.\n' +
          '               Incompatible with --provider/--model/--fixture (the matrix IS the\n' +
          '               cell selection). Composable with --dry-run ($0 oracle rehearsal).\n' +
          '               Live matrix requires BOTH OPENAI_API_KEY and ANTHROPIC_API_KEY.\n' +
          '  --include-provider\n' +
          '               Add opt-in provider rows to the matrix (repeatable; requires --matrix).\n' +
          '               openrouter -> pinned :free model, $0   (requires OPENROUTER_API_KEY)\n' +
          '               lmstudio   -> local server, $0; model discovered from <base>/v1/models;\n' +
          '                             base URL from LMSTUDIO_BASE_URL (WSL-gateway fallback).\n' +
          '  --provider   AI provider for live runs (default: openai).\n' +
          '               openai    -> default model gpt-5.4-mini   (requires OPENAI_API_KEY)\n' +
          '               anthropic -> default model claude-haiku-4-5 (requires ANTHROPIC_API_KEY)\n' +
          '               openrouter / lmstudio -> the $0 opt-in cells, as a single run.\n' +
          '  --model      Override the provider default. Must be priced in MODEL_PRICING_USD_PER_1K\n' +
          '               (openai/anthropic; claude-* models are anthropic-only, everything else\n' +
          '               openai-only), a :free variant for openrouter, or any loaded model name\n' +
          '               for lmstudio (default: discovered from /v1/models).',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (options.matrix && (providerExplicit || modelExplicit || fixtureExplicit)) {
    throw new Error(
      '--matrix is incompatible with --provider/--model/--fixture: the matrix runs the full ' +
        'provider x fixture cross-product with per-provider default models. Drop the explicit ' +
        'cell flags (or drop --matrix for a single run).',
    );
  }

  if (options.includeProviders.length > 0 && !options.matrix) {
    throw new Error(
      '--include-provider requires --matrix: it adds opt-in provider rows to the matrix ' +
        'cross-product. For a single opt-in cell use --provider openrouter|lmstudio instead.',
    );
  }

  if (!SUPPORTED_PROVIDERS.includes(options.provider)) {
    throw new Error(
      `Unknown provider "${options.provider}" — pick one of: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    );
  }
  if (options.model === null) {
    options.model = DEFAULT_MODEL_BY_PROVIDER[options.provider];
  }
  // Provider/model mismatch guard: a claude-* model sent to the OpenAI
  // endpoint (or vice versa) would 404/400 only after burning a request —
  // and in --dry-run it would silently stamp a nonsensical provider/model
  // combination into the artifacts. Fail fast instead.
  const isClaudeModel = options.model.startsWith('claude-');
  if (options.provider === 'openai' && isClaudeModel) {
    throw new Error(
      `Provider/model mismatch: model "${options.model}" is an Anthropic model. ` +
        `Use --provider anthropic (or pick an OpenAI model).`,
    );
  }
  if (options.provider === 'anthropic' && !isClaudeModel) {
    throw new Error(
      `Provider/model mismatch: model "${options.model}" is not an Anthropic (claude-*) model. ` +
        `Use --provider openai (or pick a claude-* model).`,
    );
  }
  // $0 invariant for OpenRouter: the cell is exempt from the pricing table
  // and the cost cap ONLY because the model cannot bill. A non-:free
  // override would silently spend money outside MAX_BENCHMARK_COST_USD, so
  // reject it here rather than pricing it.
  if (options.provider === 'openrouter' && !options.model.endsWith(':free')) {
    throw new Error(
      `OpenRouter benchmark cells are $0 by construction: model "${options.model}" is not a ` +
        `":free" variant. Pick a :free OpenRouter model (default: ${DEFAULT_MODEL_BY_PROVIDER.openrouter}).`,
    );
  }
  return options;
}

function loadFixture(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Fixture not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.testSuite || !Array.isArray(parsed.testCases)) {
    throw new Error(`Fixture has wrong shape: ${absPath}`);
  }
  // Backward-compat: fixtures predating the Phase B multi-target-system
  // support carry no targetSystem; they are all NetSuite.
  if (!parsed.testSuite.targetSystem) {
    parsed.testSuite.targetSystem = 'netsuite';
  }
  // Fail fast on a typo'd/unsupported targetSystem rather than erroring
  // mid-run inside the prompt builder (or, in --dry-run, silently stamping
  // a target system the runner has no schema context for).
  targetSystemContext(parsed.testSuite.targetSystem);
  return parsed;
}

// Refuse to run if the fixture overlaps with shipped few-shot examples.
// Returns the conflict list (empty if clean).
export function findDataLeakage(fixture) {
  const conflicts = [];
  const pairSet = new Set(COMMON_EXAMPLE_PAIRS.map(([s, t]) => `${s}::${t}`));
  for (const tc of fixture.testCases) {
    for (const m of tc.expectedMappings) {
      if (pairSet.has(`${m.source}::${m.target}`)) {
        conflicts.push({ case: tc.name, source: m.source, target: m.target });
      }
    }
  }
  return conflicts;
}

// Oracle provider — used in --dry-run. Returns the labeled answer for
// each labeled (source, target) pair plus deterministic confidence. This
// exercises the harness wiring without spending real money OR producing
// non-deterministic accuracy numbers across CI runs.
function oracleProvider(testCase) {
  return testCase.expectedMappings.map((m) => ({
    sourceField: m.source,
    targetField: m.target,
    confidence: 95,
    transformationType: 'direct',
  }));
}

// Shared prompt builder — OpenAI and Anthropic send byte-identical task
// content (same system string, same user prompt) so accuracy numbers are
// comparable across providers. The prompt mirrors the production prompt's
// STRUCTURE (system+user, JSON-formatted suggestions output) so the numbers
// we measure here track what production sees. The prompt is intentionally
// SHORTER than the production prompt — the few-shot examples are
// suppressed to keep the benchmark independent of the production-prompt
// data-leakage surface (see COMMON_EXAMPLE_PAIRS guard above).
function buildMappingPrompt(testCase, suite) {
  const fieldsBlock = testCase.sourceFields
    .map((f) => `  - "${f.name}" (${f.type}): sample = ${JSON.stringify(f.sample)}`)
    .join('\n');
  // Schema context + target-system wording keyed by the fixture's
  // testSuite.targetSystem. For 'netsuite' the rendered prompt is
  // byte-identical to the original Phase A single-pair prompt.
  const target = targetSystemContext(suite.testSuite.targetSystem);
  const schemaBlock = target.schemaBlock;

  const system =
    `You are an expert data integration engineer with deep expertise in Salesforce and ${target.displayName} field mapping. ` +
    'Return ONLY a JSON object — no commentary, no markdown fences.';

  const user = `Map each source field below to the most appropriate ${target.recordLabel} record field.

Source System: ${suite.testSuite.sourceSystem}
Target System: ${suite.testSuite.targetSystem}
Entity Type: ${suite.testSuite.entityType}

Source Fields:
${fieldsBlock}

${target.recordLabel} schema fields (choose the targetField from this schema when there is a fit):
${schemaBlock}

Response format (JSON, no markdown):
{
  "suggestions": [
    { "sourceField": "<exact source field name>", "targetField": "<${target.targetFieldPlaceholder}>", "confidence": <0-100>, "transformationType": "direct|lookup|calculation|concatenation" }
  ]
}

Output every source field exactly once. Use the EXACT sourceField names from the input.`;

  return { system, user };
}

// Shared response-content handling — fence-strip, JSON.parse, normalize the
// suggestion shape. Both providers funnel through this so a formatting quirk
// is handled identically regardless of which API produced the text.
function parseSuggestionsContent(content, providerLabel) {
  if (!content || typeof content !== 'string') {
    throw new Error(`${providerLabel} returned no content`);
  }

  let parsed;
  try {
    // Strip optional markdown fences just in case.
    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `${providerLabel} response not valid JSON: ${err.message} / raw: ${content.slice(0, 200)}`,
      { cause: err },
    );
  }

  const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  return suggestions.map((s) => ({
    sourceField: String(s.sourceField || ''),
    targetField: String(s.targetField || ''),
    confidence: typeof s.confidence === 'number' ? s.confidence : 0,
    transformationType: String(s.transformationType || 'direct'),
  }));
}

// Shared fetch wrapper — per-request timeout (a stalled provider response
// would otherwise wedge the benchmark; mirrors the AbortController pattern
// in `scripts/ai-config-smoke.js`) + non-2xx error surface.
async function postProviderRequest(url, headers, body, providerLabel, testCaseName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(
          `${providerLabel} request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS} ms (case: "${testCaseName}")`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '<no body>');
      throw new Error(`${providerLabel} API ${response.status} ${response.statusText}: ${text}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Shared OpenAI-compatible chat-completions caller. OpenAI, OpenRouter and
// LM Studio all speak this wire shape (messages in, choices[0].message.content
// + usage.prompt_tokens/completion_tokens out), so the three live paths
// differ only in endpoint URL, auth header, and completion-token-limit
// parameter name. Prompt content stays byte-identical across ALL providers
// (incl. Anthropic) via buildMappingPrompt.
async function callOpenAICompatible(testCase, suite, model, endpoint) {
  const { system, user } = buildMappingPrompt(testCase, suite);

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.0,
    ...endpoint.tokenLimitParam,
  };

  const json = await postProviderRequest(
    endpoint.url,
    endpoint.headers,
    body,
    endpoint.providerLabel,
    testCase.name,
  );

  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  // Reasoning models bill thinking tokens against max_tokens; when the
  // budget runs out mid-think the API returns finish_reason=length with
  // EMPTY content. Surface that specifically — "returned no content" alone
  // sent the operator hunting in the wrong direction.
  if (!content && choice?.finish_reason === 'length') {
    throw new Error(
      `${endpoint.providerLabel} exhausted the completion-token budget before emitting content ` +
        `(finish_reason=length; typically a reasoning model spending the budget on thinking). ` +
        `Case: "${testCase.name}".`,
    );
  }
  const usage = json?.usage || {};
  return {
    suggestions: parseSuggestionsContent(content, endpoint.providerLabel),
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
  };
}

// Live OpenAI provider — calls /v1/chat/completions with a single prompt
// per test case (prompt content shared with the Anthropic path via
// buildMappingPrompt).
async function callOpenAI(testCase, suite, apiKey, model) {
  return callOpenAICompatible(testCase, suite, model, {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    providerLabel: 'OpenAI',
    // gpt-5* rejects legacy max_tokens; older models reject max_completion_tokens.
    tokenLimitParam: openAICompletionTokenLimitParam(model, COMPLETION_TOKEN_BUDGET),
  });
}

// Live OpenRouter provider (opt-in cell) — OpenAI-compatible endpoint,
// Bearer OPENROUTER_API_KEY, pinned :free model so the cell bills $0.
async function callOpenRouter(testCase, suite, apiKey, model) {
  return callOpenAICompatible(testCase, suite, model, {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    providerLabel: 'OpenRouter',
    tokenLimitParam: { max_tokens: ZERO_COST_COMPLETION_TOKEN_BUDGET },
  });
}

// Live LM Studio provider (opt-in cell) — local OpenAI-compatible server,
// no auth. `baseUrl` comes from the preflight in main() (env override or
// WSL-gateway/localhost fallback, mirroring src/services/ai/utils/lmstudio.ts).
async function callLMStudio(testCase, suite, baseUrl, model) {
  return callOpenAICompatible(testCase, suite, model, {
    url: `${baseUrl}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json' },
    providerLabel: 'LM Studio',
    tokenLimitParam: { max_tokens: ZERO_COST_COMPLETION_TOKEN_BUDGET },
  });
}

// Live Anthropic provider — calls /v1/messages with the SAME system string
// and user prompt as the OpenAI path (byte-identical task content via
// buildMappingPrompt). Request shape mirrors production:
// `src/services/ai/utils/claude.ts` buildClaudeHeaders (anthropic-version +
// x-api-key against api.anthropic.com) and
// `src/services/ai/providers/ClaudeProvider.ts` callClaude (model /
// max_tokens / temperature / system / messages body).
async function callClaude(testCase, suite, apiKey, model) {
  const { system, user } = buildMappingPrompt(testCase, suite);

  const body = {
    model,
    max_tokens: COMPLETION_TOKEN_BUDGET,
    temperature: 0.0,
    system,
    messages: [{ role: 'user', content: user }],
  };

  const json = await postProviderRequest(
    'https://api.anthropic.com/v1/messages',
    {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body,
    'Anthropic',
    testCase.name,
  );

  const content = json?.content?.[0]?.text;
  const usage = json?.usage || {};
  return {
    suggestions: parseSuggestionsContent(content, 'Anthropic'),
    promptTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    completionTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  };
}

function estimateCost(promptTokens, completionTokens, model) {
  const rates = pricingForModel(model);
  return (
    (promptTokens / 1000) * rates.input +
    (completionTokens / 1000) * rates.output
  );
}

// ---------------------------------------------------------------------------
// LM Studio preflight helpers.
//
// Behavioral mirror of `resolveLMStudioBaseUrl` in
// `src/services/ai/utils/lmstudio.ts` — this plain-ESM script cannot import
// the TS module, so the resolution rules are reproduced here: explicit
// LMSTUDIO_BASE_URL is normalized (trim + strip trailing slashes;
// whitespace-only counts as unset); unset under WSL resolves the Windows-host
// NAT gateway from /proc/net/route; otherwise 127.0.0.1:1234. Keep in
// lockstep with the TS source when its rules change.
const DEFAULT_LMSTUDIO_PORT = 1234;

function resolveLMStudioBaseUrlForBenchmark(rawBaseUrl) {
  const normalized = rawBaseUrl ? rawBaseUrl.trim().replace(/\/+$/, '') : '';
  if (normalized) {
    return normalized;
  }

  const isWsl =
    Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) || /microsoft/i.test(osRelease());
  if (isWsl) {
    try {
      const routeTable = fs.readFileSync('/proc/net/route', 'utf8');
      for (const line of routeTable.split(/\r?\n/).slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 3) continue;
        const [, destination, gateway] = columns;
        if (destination !== '00000000' || gateway === '00000000') continue;
        const octets = gateway.match(/../g)?.map((part) => Number.parseInt(part, 16));
        if (!octets || octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) continue;
        return `http://${octets.reverse().join('.')}:${DEFAULT_LMSTUDIO_PORT}`;
      }
    } catch {
      // Unreadable route table — fall through to the localhost default.
    }
  }
  return `http://127.0.0.1:${DEFAULT_LMSTUDIO_PORT}`;
}

// `GET <base>/v1/models` — the reachability preflight for EVERY live run
// with an lmstudio cell (a run must fail on an unreachable local server
// before any other cell spends), and the model-discovery source when the
// cell model is the 'auto' sentinel. Returns the model id list; empty is
// legal here because LM Studio can JIT-load an explicitly-pinned --model —
// the caller enforces non-empty only when it actually needs to discover.
async function fetchLMStudioModelIds(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(
          `LM Studio model listing timed out after ${PROVIDER_REQUEST_TIMEOUT_MS} ms (${baseUrl}/v1/models)`,
          { cause: err },
        );
      }
      throw new Error(
        `LM Studio unreachable at ${baseUrl} — is the server running (and bound non-loopback under WSL)? ${err.message}`,
        { cause: err },
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '<no body>');
      throw new Error(`LM Studio /v1/models ${response.status} ${response.statusText}: ${text}`);
    }
    const json = await response.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' && id.length > 0);
  } finally {
    clearTimeout(timeout);
  }
}

// Wilson 95% score interval for a binomial proportion (z = 1.96). Chosen
// over the normal approximation because the benchmark cells are small-n
// (11-61 mappings) with accuracies near 1.0, exactly where the normal
// interval degenerates (zero/negative width at p=1). Returns
// { low, high } as 4-dp fractions clamped to [0, 1]; null when n = 0
// (no labeled mappings — no interval to report).
export function wilsonInterval(successes, n, z = 1.96) {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n <= 0 || successes < 0 || successes > n) {
    return null;
  }
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return {
    low: Number(Math.max(0, center - margin).toFixed(4)),
    high: Number(Math.min(1, center + margin).toFixed(4)),
  };
}

// Render a CI as a markdown-friendly percent range, e.g. "[86.7%, 98.3%]".
function formatCi95(ci) {
  if (!ci) return 'n/a';
  return `[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`;
}

// Per-case evaluator. Returns { correct, total, hallucinations, details }.
export function evaluateCase(testCase, suggestions) {
  const expectedSourceFields = new Set(testCase.sourceFields.map((f) => f.name));
  let correct = 0;
  const details = [];

  for (const exp of testCase.expectedMappings) {
    const match = suggestions.find((s) => s.sourceField === exp.source);
    const ok = match?.targetField === exp.target;
    if (ok) correct += 1;
    details.push({
      source: exp.source,
      expectedTarget: exp.target,
      actualTarget: match?.targetField || null,
      match: ok,
    });
  }

  const hallucinations = suggestions.filter((s) => !expectedSourceFields.has(s.sourceField)).length;

  return {
    correct,
    total: testCase.expectedMappings.length,
    hallucinations,
    details,
  };
}

function buildMarkdown(summary) {
  const target = targetSystemContext(summary.target_system);
  const isMatrix = summary.runs.length > 1;
  const lines = [];
  lines.push('# AI Accuracy Benchmark — Latest Run');
  lines.push('');
  lines.push('<!-- This file is regenerated by `npm run benchmark:ai`. Manual edits will be overwritten. -->');
  lines.push('');
  lines.push(`**Run mode:** \`${summary.run_mode}\`  `);
  lines.push(`**Headline provider:** ${summary.provider} (${summary.model})  `);
  lines.push(`**Generated:** ${summary.generated_at}`);
  lines.push('');
  lines.push('## Phase B scope (+ A/C follow-ups)');
  lines.push('');
  lines.push('- **Two ERP pairs:** Salesforce Account -> NetSuite Customer and Salesforce Account -> Business Central Customer.');
  lines.push('- **Two base providers:** OpenAI (default, `gpt-5.4-mini`) and Anthropic (`claude-haiku-4-5`) via `--provider`; `--matrix` runs the full provider x pair cross-product (4 cells) in one invocation under a single cost cap.');
  lines.push('- **Two opt-in providers:** OpenRouter (pinned `:free` model, $0, requires `OPENROUTER_API_KEY`) and LM Studio (local server, $0, model discovered from `/v1/models`) via `--include-provider` (matrix) or `--provider` (single run). Never part of the default matrix or the canonical headline.');
  lines.push('- **Metrics:** top-1 accuracy with a Wilson 95% CI per cell, plus hallucination count. Self-consistency is still out of scope.');
  lines.push('- **Remaining cuts:** no nightly CI smoke (manual invocation only); population-level absolute-% claims still require broader fixtures than these hand-labeled sets (the CI quantifies sampling noise on the fixture, not fixture representativeness).');
  lines.push('');
  lines.push('## Provider x pair matrix');
  lines.push('');
  if (!isMatrix) {
    lines.push('Single-run invocation — one cell. Run with `--matrix` for the full provider x pair cross-product.');
    lines.push('');
  }
  lines.push('| Provider | Model | Pair | Mappings | Top-1 accuracy | 95% CI (Wilson) | Hallucinations | Cost (USD) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const run of summary.runs) {
    lines.push(
      `| ${run.provider} | ${run.model} | \`${run.pair}\` | ${run.fixture_mappings} | ` +
        `${(run.accuracy_top1 * 100).toFixed(1)}% | ${formatCi95(run.accuracy_top1_ci95)} | ` +
        `${run.hallucination_count} | $${run.estimated_cost_usd.toFixed(4)} |`,
    );
  }
  lines.push('');
  lines.push(`Total estimated cost across runs: $${summary.total_estimated_cost_usd.toFixed(4)} (cap $${summary.max_cost_usd.toFixed(2)} for the whole invocation).`);
  lines.push('');
  lines.push(`## Headline run${isMatrix ? ' (canonical cell: openai x sfdc-to-ns-customers)' : ''}`);
  lines.push('');
  if (isMatrix) {
    lines.push('The top-level JSON fields (and the README `ai_accuracy` metric) mirror this cell; the matrix table above carries the rest.');
    lines.push('');
  }
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Run mode | \`${summary.run_mode}\` |`);
  lines.push(`| Provider | ${summary.provider} |`);
  lines.push(`| Model | ${summary.model} |`);
  lines.push(`| Fixture | \`${summary.fixture}\` |`);
  lines.push(`| Target system | ${target.displayName} |`);
  lines.push(`| Test cases | ${summary.fixture_cases} |`);
  lines.push(`| Total labeled mappings | ${summary.fixture_mappings} |`);
  lines.push(`| **Top-1 accuracy** | **${(summary.accuracy_top1 * 100).toFixed(1)}%** |`);
  lines.push(`| 95% CI (Wilson) | ${formatCi95(summary.accuracy_top1_ci95)} |`);
  lines.push(`| Hallucination count | ${summary.hallucination_count} |`);
  lines.push(`| Manual edit rate | ${(summary.manual_edit_rate * 100).toFixed(1)}% |`);
  lines.push(`| Estimated cost (USD) | $${summary.estimated_cost_usd.toFixed(4)} |`);
  lines.push(`| Cost cap (USD) | $${summary.max_cost_usd.toFixed(2)} |`);
  lines.push('');
  lines.push('## Data-leakage guard');
  lines.push('');
  lines.push(
    'Every fixture is REQUIRED to exclude every `(sourceField, targetField)` pair that appears in ' +
      '`src/services/ai/prompts/FieldMappingPrompts.ts` `COMMON_MAPPING_EXAMPLES`. The few-shot examples ship in ' +
      'production prompts, so allowing them in the benchmark would let the model "cheat" against patterns it was ' +
      'just taught. The prompt may include broad target schema context, but it is REQUIRED to include ' +
      'substantial distractors and not embed only the fixture target answer-set as an allowed vocabulary. ' +
      'Per-pair posture:',
  );
  lines.push('');
  lines.push(
    `- **SFDC -> NetSuite** (\`sfdc-to-ns-customers\`): broad NetSuite Customer schema ` +
      `(${NETSUITE_CUSTOMER_SCHEMA_FIELDS.length} fields) as candidates, with a >=75 absolute-distractor ` +
      'floor relative to the fixture answer-set.',
  );
  lines.push(
    `- **SFDC -> Business Central** (\`sfdc-to-bc-customers\`): the COMPLETE real OData customers schema ` +
      `(${BC_CUSTOMER_SCHEMA_FIELDS.length} fields — every scalar Property of ` +
      '`src/connectors/fixtures/bc/metadata/customers.xml`, parity-tested against the XML) as candidates. ' +
      'Because the real schema is small, the absolute floor is replaced by a proportional rule: the fixture ' +
      'labels at most floor(schema/2) distinct targets, guaranteeing >=50% distractors.',
  );
  lines.push('');
  lines.push(
    'Both exclusions and the per-pair posture are enforced by ' +
      '`tests/unit/scripts/run-ai-accuracy-benchmark.dataLeakage.test.ts`.',
  );
  lines.push('');
  lines.push('## Runbook (operator)');
  lines.push('');
  lines.push('```bash');
  lines.push('# Rehearsal -- deterministic mock provider, $0 cost. Used by CI / drift tests.');
  lines.push('npm run benchmark:ai -- --dry-run --matrix');
  lines.push('');
  lines.push('# The script does NOT load .env -- export the keys into the shell first:');
  lines.push('set -a; source .env; set +a');
  lines.push('');
  lines.push('# Live full matrix -- requires BOTH OPENAI_API_KEY and ANTHROPIC_API_KEY.');
  lines.push('# MAX_BENCHMARK_COST_USD caps the budget for the WHOLE invocation (default $5).');
  lines.push('# Runner refuses to start if the pessimistic worst-case estimate summed over all');
  lines.push('# cells exceeds the cap AND aborts mid-run on the iteration whose actual');
  lines.push('# cumulative spend (across cells) would cross it.');
  lines.push('MAX_BENCHMARK_COST_USD=5 npm run benchmark:ai -- --matrix');
  lines.push('');
  lines.push('# Opt-in $0 providers (never part of the default matrix or the canonical headline):');
  lines.push('#   openrouter -> pinned :free model, requires OPENROUTER_API_KEY');
  lines.push('#   lmstudio   -> local server; model discovered from <base>/v1/models; base URL from');
  lines.push('#                 LMSTUDIO_BASE_URL (unset under WSL resolves the Windows-host gateway)');
  lines.push('npm run benchmark:ai -- --matrix --include-provider openrouter --include-provider lmstudio');
  lines.push('');
  lines.push('# Single-cell variants (incompatible with --matrix):');
  lines.push('npm run benchmark:ai                                                              # openai x SFDC->NS');
  lines.push('npm run benchmark:ai -- --provider anthropic                                      # claude-haiku-4-5');
  lines.push('npm run benchmark:ai -- --provider lmstudio                                       # local, $0');
  lines.push('npm run benchmark:ai -- --fixture scripts/golden/fixtures/sfdc-to-bc-customers.yaml  # SFDC->BC');
  lines.push('');
  lines.push('# After a live run, re-stamp the README templated value:');
  lines.push('npm run metrics:generate && npm run metrics:sync-tokens');
  lines.push('git add docs/review/ai-accuracy-benchmark.json docs/review/ai-accuracy-benchmark.md metrics.json README.md');
  lines.push('```');
  lines.push('');
  lines.push('## Known limitations');
  lines.push('');
  lines.push('- The benchmark measures top-1 accuracy on small hand-labeled sets. The Wilson 95% CI quantifies sampling noise at that fixture size (small-n intervals are wide by construction), but it is NOT a population-level claim: the fixtures are curated, not sampled from production traffic.');
  lines.push('- The "hallucination" metric is conservatively defined as a suggestion whose `sourceField` does not appear in the test case\'s labeled source fields. Within-source-but-wrong-target counts as a top-1 miss, not a hallucination.');
  lines.push('- The dry-run mock is deterministic by construction (oracle returns the labeled answer). It validates the harness wiring, not the model. Trust the live-run accuracy numbers.');
  lines.push('');
  return lines.join('\n');
}

// `pair` identifier for a fixture path — basename sans extension
// (e.g. 'sfdc-to-ns-customers').
function pairIdForFixture(fixturePath) {
  return path.basename(fixturePath, path.extname(fixturePath));
}

// Run one provider × fixture cell. Mutates `costTracker.cumulativeUsd` so
// the MAX_BENCHMARK_COST_USD mid-run abort applies to the cumulative actual
// spend ACROSS cells (single cap per invocation), not per cell. Throws on
// any provider/parse/cost failure — a failed cell fails the whole
// invocation; no partial artifact is ever written.
async function runCell(cell, fixture, options, maxCostUsd, costTracker) {
  const pair = pairIdForFixture(cell.fixture);
  const apiKey = options.dryRun ? null : process.env[API_KEY_ENV_BY_PROVIDER[cell.provider]];

  let totalCorrect = 0;
  let totalMappings = 0;
  let totalHallucinations = 0;
  let cellCostUsd = 0;
  const detailRows = [];
  const startedAt = Date.now();

  for (const tc of fixture.testCases) {
    let suggestions;
    if (options.dryRun) {
      suggestions = oracleProvider(tc);
    } else {
      let result;
      if (cell.provider === 'anthropic') {
        result = await callClaude(tc, fixture, apiKey, cell.model);
      } else if (cell.provider === 'openrouter') {
        result = await callOpenRouter(tc, fixture, apiKey, cell.model);
      } else if (cell.provider === 'lmstudio') {
        result = await callLMStudio(tc, fixture, cell.lmstudioBaseUrl, cell.model);
      } else {
        result = await callOpenAI(tc, fixture, apiKey, cell.model);
      }
      suggestions = result.suggestions;
      // Runtime cumulative-cost check. The pre-flight cap uses a
      // pessimistic 1K-in / 1K-out budget, but real cases can run longer
      // (verbose system prompts, long completions). If actual cumulative
      // spend across ALL cells so far has already crossed the cap, abort
      // the remainder of the run — partial results are dropped, no
      // artifacts written, exit nonzero so the operator notices.
      // Zero-cost providers ($0 by construction) skip the pricing table —
      // their models (`:free` variants, locally-loaded LM Studio models)
      // are intentionally NOT in MODEL_PRICING_USD_PER_1K.
      const caseCostUsd = ZERO_COST_PROVIDERS.has(cell.provider)
        ? 0
        : estimateCost(result.promptTokens, result.completionTokens, cell.model);
      cellCostUsd += caseCostUsd;
      costTracker.cumulativeUsd += caseCostUsd;
      if (costTracker.cumulativeUsd > maxCostUsd) {
        throw new Error(
          `Cost cap exceeded mid-run: cumulative ${costTracker.cumulativeUsd.toFixed(4)} USD > MAX_BENCHMARK_COST_USD ${maxCostUsd.toFixed(2)} ` +
            `after case "${tc.name}" (${cell.provider} x ${pair}). Bump the cap or shrink the fixture and re-run.`,
        );
      }
    }
    const evalResult = evaluateCase(tc, suggestions);
    totalCorrect += evalResult.correct;
    totalMappings += evalResult.total;
    totalHallucinations += evalResult.hallucinations;
    detailRows.push({
      case: tc.name,
      correct: evalResult.correct,
      total: evalResult.total,
      hallucinations: evalResult.hallucinations,
      details: evalResult.details,
    });
    if (options.verbose) {
      console.log(`  [${cell.provider} x ${pair}] ${tc.name}: ${evalResult.correct}/${evalResult.total} correct, ${evalResult.hallucinations} hallucinations`);
    }
  }

  const accuracyTop1 = totalMappings > 0 ? totalCorrect / totalMappings : 0;
  const manualEditRate = totalMappings > 0 ? (totalMappings - totalCorrect) / totalMappings : 0;

  return {
    run: {
      pair,
      fixture: cell.fixture,
      target_system: fixture.testSuite.targetSystem,
      // provider/model reflect the SELECTED provider even in --dry-run (the
      // oracle answers, but the artifacts must say which provider/model the
      // run was configured for); run_mode distinguishes oracle from live.
      provider: cell.provider,
      model: cell.model,
      run_mode: options.dryRun ? 'dry-run' : 'live',
      fixture_cases: fixture.testCases.length,
      fixture_mappings: totalMappings,
      accuracy_top1: Number(accuracyTop1.toFixed(4)),
      // Wilson 95% score interval over (correct, mappings) — quantifies the
      // small-n sampling noise on accuracy_top1 (null when n = 0).
      accuracy_top1_ci95: wilsonInterval(totalCorrect, totalMappings),
      hallucination_count: totalHallucinations,
      manual_edit_rate: Number(manualEditRate.toFixed(4)),
      estimated_cost_usd: options.dryRun ? 0 : Number(cellCostUsd.toFixed(6)),
      duration_ms: Date.now() - startedAt,
    },
    detailRows,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Cell list: --matrix is the full provider × fixture cross-product with
  // per-provider default models (base providers + any --include-provider
  // opt-ins); otherwise one cell from the CLI options.
  // (lmstudioBaseUrl is filled by the LM Studio preflight below; null for
  // every other provider and in --dry-run.)
  const cells = options.matrix
    ? [...MATRIX_PROVIDERS, ...options.includeProviders].flatMap((provider) =>
        MATRIX_FIXTURES.map((fixture) => ({
          provider,
          model: DEFAULT_MODEL_BY_PROVIDER[provider],
          fixture,
          lmstudioBaseUrl: /** @type {string|null} */ (null),
        })),
      )
    : [{
        provider: options.provider,
        model: options.model,
        fixture: options.fixture,
        lmstudioBaseUrl: /** @type {string|null} */ (null),
      }];

  // $0 invariant for OpenRouter, enforced on the CONSTRUCTED cell list:
  // parseArgs already rejects a non-:free --model (better flag-context
  // error, fails before fixtures load), but matrix cells take their model
  // from DEFAULT_MODEL_BY_PROVIDER, which parseArgs never sees. Without
  // this tripwire a future edit to that default could silently bill
  // outside MAX_BENCHMARK_COST_USD, since openrouter is exempt from the
  // pricing/cap math via ZERO_COST_PROVIDERS (Copilot R3).
  for (const cell of cells) {
    if (cell.provider === 'openrouter' && !cell.model.endsWith(':free')) {
      throw new Error(
        `OpenRouter benchmark cells are $0 by construction: cell model "${cell.model}" is not a ` +
          `":free" variant. Fix DEFAULT_MODEL_BY_PROVIDER.openrouter (or the --model override) to a :free model.`,
      );
    }
  }

  // Load each distinct fixture once and run the data-leakage refusal on it.
  const fixturesByPath = new Map();
  for (const cell of cells) {
    if (fixturesByPath.has(cell.fixture)) continue;
    const fixture = loadFixture(path.resolve(REPO_ROOT, cell.fixture));
    const conflicts = findDataLeakage(fixture);
    if (conflicts.length > 0) {
      console.error(`[benchmark:ai] FATAL: fixture ${cell.fixture} overlaps with COMMON_MAPPING_EXAMPLES (data leakage):`);
      for (const c of conflicts) {
        console.error(`  - case "${c.case}": ${c.source} -> ${c.target}`);
      }
      process.exit(2);
    }
    fixturesByPath.set(cell.fixture, fixture);
  }

  // Cost-cap precheck. Pessimistic — assume 1K input + 1K output per case,
  // summed over ALL cells at each cell's model rates: one cap for the whole
  // invocation, checked BEFORE any API call.
  const maxCostUsd = Number(process.env.MAX_BENCHMARK_COST_USD ?? DEFAULT_MAX_COST_USD);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new Error(`MAX_BENCHMARK_COST_USD must be a non-negative number; got ${process.env.MAX_BENCHMARK_COST_USD}`);
  }
  // Skip pricing validation in --dry-run mode: the oracle provider doesn't
  // call any API, so the cost cap is irrelevant and we don't want a stale
  // --model arg to throw the unknown-model error on a $0 run. Per Copilot
  // review on PR #837.
  if (!options.dryRun) {
    // Zero-cost providers are exempt from the cap math: their models are
    // intentionally unpriced (`:free` variants, locally-loaded LM Studio
    // models), and pricing them at $0 would only obscure the invariant.
    const worstCaseCostUsd = cells.reduce(
      (sum, cell) =>
        ZERO_COST_PROVIDERS.has(cell.provider)
          ? sum
          : sum + fixturesByPath.get(cell.fixture).testCases.length * estimateCost(1000, 1000, cell.model),
      0,
    );
    if (worstCaseCostUsd > maxCostUsd) {
      throw new Error(
        `Cost cap exceeded: estimated worst-case ${worstCaseCostUsd.toFixed(4)} USD across ${cells.length} cell(s) > ` +
          `MAX_BENCHMARK_COST_USD ${maxCostUsd.toFixed(2)}. Either bump the cap or shrink the fixture(s).`,
      );
    }

    // API keys required for live mode — every provider in the cell list,
    // verified up front so a matrix run can't burn one provider's budget
    // and then die on the other's missing key. (null = keyless provider:
    // LM Studio is a local server.)
    const neededKeyVars = [
      ...new Set(cells.map((cell) => API_KEY_ENV_BY_PROVIDER[cell.provider]).filter(Boolean)),
    ];
    const missing = neededKeyVars.filter((envVar) => !process.env[envVar]);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required for live mode. ` +
          `Use --dry-run for the deterministic oracle.`,
      );
    }

    // LM Studio preflight: resolve the base URL once and hit /v1/models
    // BEFORE any cell runs — the run must fail on an unreachable local
    // server before any other cell spends (Copilot R1: the reachability
    // check runs even when --model pinned a name, not just for 'auto').
    // The listing doubles as model discovery for 'auto' cells; a pinned
    // model tolerates an empty list (LM Studio can JIT-load it). Dry-run
    // never contacts the server; its artifacts keep the 'auto' sentinel.
    const lmstudioCells = cells.filter((cell) => cell.provider === 'lmstudio');
    if (lmstudioCells.length > 0) {
      const baseUrl = resolveLMStudioBaseUrlForBenchmark(process.env.LMSTUDIO_BASE_URL);
      const modelIds = await fetchLMStudioModelIds(baseUrl);
      const needsDiscovery = lmstudioCells.some((cell) => cell.model === LMSTUDIO_MODEL_AUTO);
      // Auto-discovery must skip embedding-only models — LM Studio lists
      // them alongside chat models and they 4xx on /v1/chat/completions.
      // Same id-substring filter as the established probe in
      // tests/integration/semantic-analysis-integration.test.ts (Codex P2).
      const chatModelIds = modelIds.filter((id) => !id.toLowerCase().includes('embed'));
      if (needsDiscovery && chatModelIds.length === 0) {
        throw new Error(
          modelIds.length > 0
            ? `LM Studio at ${baseUrl} lists only embedding models (${modelIds.join(', ')}) — load a chat model or pass --model.`
            : `LM Studio at ${baseUrl} reports no loaded models — load a model in LM Studio or pass --model.`,
        );
      }
      for (const cell of lmstudioCells) {
        cell.lmstudioBaseUrl = baseUrl;
        if (cell.model === LMSTUDIO_MODEL_AUTO) {
          cell.model = chatModelIds[0];
        }
      }
      console.log(
        `[benchmark:ai] LM Studio preflight: ${baseUrl}${needsDiscovery ? ` (model: ${chatModelIds[0]})` : ' (reachable; model pinned)'}`,
      );
    }
  }

  // Run every cell sequentially under the shared cost tracker. Any cell
  // failure (including the canonical cell) aborts the whole invocation —
  // no partial artifact.
  const costTracker = { cumulativeUsd: 0 };
  const runs = [];
  const detailCells = [];
  for (const cell of cells) {
    if (options.matrix) {
      console.log(`[benchmark:ai] cell ${runs.length + 1}/${cells.length}: ${cell.provider} (${cell.model}) x ${pairIdForFixture(cell.fixture)}`);
    }
    const { run, detailRows } = await runCell(cell, fixturesByPath.get(cell.fixture), options, maxCostUsd, costTracker);
    runs.push(run);
    detailCells.push({ pair: run.pair, provider: run.provider, model: run.model, cases: detailRows });
  }

  // Headline mirror: canonical run = openai × sfdc-to-ns-customers in matrix
  // mode; the (only) run itself in single-run mode.
  const canonical = options.matrix
    ? runs.find((r) => r.provider === CANONICAL_PROVIDER && r.fixture === CANONICAL_FIXTURE)
    : runs[0];
  if (!canonical) {
    throw new Error(
      `Canonical cell (${CANONICAL_PROVIDER} x ${pairIdForFixture(CANONICAL_FIXTURE)}) missing from matrix run — refusing to write artifacts.`,
    );
  }

  // Reported total is the sum of per-cell values already rounded to 6 dp —
  // NOT the unrounded abort accumulator in costTracker (which stays
  // conservative for the cap check). Sub-cent divergence is expected.
  const totalEstimatedCostUsd = Number(
    runs.reduce((sum, r) => sum + r.estimated_cost_usd, 0).toFixed(6),
  );

  const summary = {
    schema_version: 3,
    _note:
      'Top-level headline fields mirror the canonical run (openai x sfdc-to-ns-customers in --matrix ' +
      'mode; the single run otherwise); runs[] carries every provider x pair cell of this invocation. ' +
      'v3 adds accuracy_top1_ci95 (Wilson 95% score interval) per run + headline mirror. ' +
      'accuracy_top1 (fraction 0..1) is mirrored into metrics.json:ai_accuracy.latest by ' +
      'scripts/generate-metrics.mjs; README templates substitute METRIC:ai_accuracy.latest_pct. ' +
      'See docs/review/ai-accuracy-benchmark.md for the runbook.',
    run_mode: canonical.run_mode,
    provider: canonical.provider,
    model: canonical.model,
    fixture: canonical.fixture,
    target_system: canonical.target_system,
    fixture_cases: canonical.fixture_cases,
    fixture_mappings: canonical.fixture_mappings,
    accuracy_top1: canonical.accuracy_top1,
    accuracy_top1_ci95: canonical.accuracy_top1_ci95,
    hallucination_count: canonical.hallucination_count,
    manual_edit_rate: canonical.manual_edit_rate,
    estimated_cost_usd: canonical.estimated_cost_usd,
    max_cost_usd: maxCostUsd,
    duration_ms: canonical.duration_ms,
    generated_at: new Date().toISOString(),
    total_estimated_cost_usd: totalEstimatedCostUsd,
    runs,
  };

  // Persist artifacts.
  const jsonAbs = path.resolve(REPO_ROOT, options.jsonOut);
  fs.mkdirSync(path.dirname(jsonAbs), { recursive: true });
  fs.writeFileSync(jsonAbs, `${JSON.stringify(summary, null, 2)}\n`);

  const mdAbs = path.resolve(REPO_ROOT, options.mdOut);
  fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
  fs.writeFileSync(mdAbs, buildMarkdown(summary));

  if (options.detailsOut) {
    const detailsAbs = path.resolve(REPO_ROOT, options.detailsOut);
    fs.mkdirSync(path.dirname(detailsAbs), { recursive: true });
    // Single-run keeps the pre-Phase-B `{summary, cases}` shape; matrix
    // nests per-cell case detail under `cells`.
    const detailsPayload = options.matrix
      ? { summary, cells: detailCells }
      : { summary, cases: detailCells[0].cases };
    fs.writeFileSync(detailsAbs, `${JSON.stringify(detailsPayload, null, 2)}\n`);
  }

  console.log(`[benchmark:ai] ${summary.run_mode} ${options.matrix ? `matrix run complete (${runs.length} cells).` : 'run complete.'}`);
  for (const run of runs) {
    console.log(`  [${run.provider} x ${run.pair}] top-1 ${(run.accuracy_top1 * 100).toFixed(1)}% (95% CI ${formatCi95(run.accuracy_top1_ci95)}), ${run.hallucination_count} hallucinations, $${run.estimated_cost_usd.toFixed(4)}, ${run.duration_ms} ms`);
  }
  console.log(`  Headline (canonical) top-1: ${(summary.accuracy_top1 * 100).toFixed(1)}% (${summary.provider}, ${summary.model})`);
  console.log(`  Manual edit rate:           ${(summary.manual_edit_rate * 100).toFixed(1)}%`);
  console.log(`  Total estimated cost (USD): $${summary.total_estimated_cost_usd.toFixed(4)}`);
  console.log(`  JSON: ${path.relative(REPO_ROOT, jsonAbs)}`);
  console.log(`  MD:   ${path.relative(REPO_ROOT, mdAbs)}`);

  return summary;
}

export { COMMON_EXAMPLE_PAIRS };

// Execute when invoked directly (not when imported by jest).
const invokedAsScript = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
if (invokedAsScript) {
  main().catch((err) => {
    console.error(`[benchmark:ai] ${err.message}`);
    process.exit(1);
  });
}
