import { injectable, inject } from 'inversify';
import type { FieldMapping, TransformationRule, DataRecord, ValidationRule } from '../types';
import type { Logger } from '../utils/Logger';
import _ from 'lodash';
import { TYPES } from '../inversify/types';
import { safeEvaluateSync, validateExpression } from '../utils/safeExprEval';
import { DECLARED_ONLY_TRANSFORMATIONS, addressesForbiddenSegment, resolveLookupTable, validateMappingSet } from '../domain/mapping/MappingContract';
import { toPath } from 'lodash';

/**
 * Read a field path from a record's fields by OWN properties only. `_.get`
 * walks the prototype chain, so a source named `toString` that the record
 * does not own resolved to Object.prototype's function and was written to
 * the target as a success (Codex round 13 on PR #1253).
 */
function readOwn(fields: unknown, path: _.PropertyPath): unknown {
  return _.has(fields as object, path) ? _.get(fields, path) : undefined;
}

type Scalar = string | number | boolean | null;
const isScalar = (v: unknown): v is Scalar => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * The evaluator represents scalars only; it silently coerces an object or an
 * array to a NUMBER (`{a:1}` -> 0, `[2]` -> 2; Codex round 15 on PR #1253).
 * Only own scalar fields enter an expression scope — an object-valued field
 * referenced bare is an unknown identifier, and referenced as ${path} is an
 * error (see bindReferences).
 */
function scalarScope(...records: (Record<string, unknown> | undefined)[]): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const fields of records) {
    if (!fields) continue;
    for (const key of Object.keys(fields)) {
      const v = fields[key];
      if (isScalar(v)) scope[key] = v; else if (v === undefined) scope[key] = null; else delete scope[key];
    }
  }
  return scope;
}

/**
 * Replace every `${path}` in `text` with a generated identifier bound in
 * `scope` to the value `read(path)` returns. The generated name skips any
 * name already in scope (a real field named `__ref0` was overwritten; Codex
 * round 15), and a non-scalar value is refused rather than coerced.
 */
function bindReferences(text: string, scope: Record<string, unknown>, read: (path: string) => unknown, reserved: Iterable<string> = []): string {
  // A non-scalar field is kept OUT of the scope, so its name must be reserved
  // separately or a generated binding would take it (Codex round 16).
  const taken = new Set<string>(reserved);
  let n = 0;
  return text.replace(/\$\{([^}]+)\}/g, (_match: string, rawPath: string) => {
    const path = rawPath.trim();
    let name = `__ref${n++}`;
    while (Object.prototype.hasOwnProperty.call(scope, name) || taken.has(name)) name = `__ref${n++}`;
    const value = read(path);
    if (value !== undefined && !isScalar(value)) {
      throw new Error(`reference '${path}' is not a scalar value (${Array.isArray(value) ? 'array' : typeof value}) and cannot be evaluated`);
    }
    scope[name] = value === undefined ? null : value;
    return name;
  });
}

/**
 * Write a rule's result to a record field. lodash `_.set` refuses a path that
 * addresses __proto__/constructor/prototype and writes the key "" for an empty
 * segment — silently, with the rule then reported as applied (Codex round 15).
 */
function setField(fields: unknown, path: string, value: unknown): void {
  const segs = toPath(path);
  if (!path || segs.length === 0 || segs.some((s) => s.length === 0) || addressesForbiddenSegment(path)) {
    throw new Error(`target path '${path}' is not writable (empty segment or __proto__/constructor/prototype)`);
  }
  _.set(fields as object, path, value);
}

const OPERATOR_WORDS: Record<string, string> = { and: '&&', or: '||', eq: '==', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };

/**
 * Rewrite the condition vocabulary (`and`, `or`, `eq`, …) to the evaluator's
 * operators — OUTSIDE string literals only. A blanket regex rewrote the
 * literal in `status == "and"` and the rule silently never applied (Codex
 * round 14 on PR #1253). A bare field NAMED like an operator word still
 * cannot be written bare; reference it as ${and}, which is bound under a
 * generated name.
 */
function rewriteOperatorWords(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // copy the literal verbatim, honouring backslash escapes
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      const op = OPERATOR_WORDS[word.toLowerCase()];
      out += op ?? word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface TransformationContext {
  sourceData: DataRecord;
  targetData?: Partial<DataRecord>;
  mappings: FieldMapping[];
  rules: TransformationRule[];
  additionalContext?: Record<string, unknown>;
}

export interface TransformationResult {
  success: boolean;
  transformedData: DataRecord;
  errors: TransformationError[];
  warnings: string[];
}

export interface TransformationError {
  field: string;
  rule?: string;
  message: string;
  severity: 'warning' | 'error';
}

/**
 * A mapping declared a transformation type that no engine branch implements
 * (`DECLARED_ONLY_TRANSFORMATIONS`). Before Task A2 the `default:` branch
 * passed the source value through unchanged, so such a mapping silently did
 * nothing. It is an error regardless of `isRequired`: the mapping is wrong,
 * not the data.
 */
export class UnsupportedTransformationError extends Error {
  constructor(public readonly transformationType: string, public readonly sourceField: string) {
    super(`transformationType '${transformationType}' is declared but not executable (mapping ${sourceField})`);
    this.name = 'UnsupportedTransformationError';
  }
}

/** Thrown by `transformRecord()` when `transform()` did not succeed; carries every per-field error. */
export class TransformationFailedError extends Error {
  constructor(public readonly errors: TransformationError[]) {
    super(`transformation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    this.name = 'TransformationFailedError';
  }
}

/**
 * The TransformationEngine class is responsible for applying field mappings and transformation rules
 * to data records during the integration process. It supports various transformation types
 * including direct mapping, lookups, calculations, and concatenations, as well as business logic and validation rules.
 */
@injectable()
export class TransformationEngine {
  protected readonly logger: Logger;
  // Codex round 14 on PR #1253: the lookup cache was keyed by table NAME and
  // value only, so two mappings sharing a name served each other's results
  // and a cached optional miss satisfied a later REQUIRED lookup — across
  // transformations, since the engine is a singleton. A lookup is one
  // own-property read of an in-memory table; there is nothing to cache.

  /**
   * Creates an instance of TransformationEngine.
   * @param {Logger} logger - The logger instance for logging messages.
   */
  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  async transformRecord(
    sourceRecord: DataRecord,
    fieldMappings: FieldMapping[],
    transformationRules: TransformationRule[],
  ): Promise<Record<string, unknown>> {
    if (!sourceRecord) {
      throw new Error('Source record cannot be null or undefined');
    }
    const context: TransformationContext = {
      sourceData: sourceRecord,
      mappings: fieldMappings,
      rules: transformationRules,
    };

    const result = await this.transform(context);
    // Task A2: never hand back partial fields as if the record were transformed.
    if (!result.success) {
      throw new TransformationFailedError(result.errors);
    }
    return result.transformedData.fields as Record<string, unknown>;
  }

  async transform(context: TransformationContext): Promise<TransformationResult> {
    const { sourceData, mappings, rules } = context;
    const errors: TransformationError[] = [];
    const warnings: string[] = [];
    let transformedData: DataRecord = {
      id: sourceData.id,
      externalId: sourceData.externalId,
      fields: {} as Record<string, unknown>,
      metadata: {
        source: 'transformation',
        lastModified: new Date(),
        version: '1.0',
      },
    };

    try {
      // Task A2: the set must be structurally valid before anything executes.
      // Declared-only types are allowed HERE so they reach applyFieldMapping
      // and are attributed to their own target field; a schema failure is
      // the general error (outer catch) and yields no fields at all.
      const structural = validateMappingSet(mappings, { allowDeclaredOnly: true });
      if (!structural.ok) {
        throw new Error(`mapping set invalid: ${structural.issues.join('; ')}`);
      }

      // Apply field mappings
      for (const mapping of mappings) {
        try {
          // Validate mapping configuration
          if (!mapping.sourceField || mapping.sourceField === '') {
            throw new Error('Source field cannot be empty');
          }
          if (!mapping.targetField || mapping.targetField === '') {
            throw new Error('Target field cannot be empty');
          }

          const result = await this.applyFieldMapping(sourceData, mapping);
          if (result.value !== undefined) {
            _.set(transformedData.fields as any, mapping.targetField, result.value);
          }
          if (result.warnings) {
            warnings.push(...result.warnings);
          }
        } catch (error) {
          errors.push({
            field: mapping.targetField || 'unknown',
            message: error instanceof Error ? error.message : String(error),
            // Every throw that reaches here is an EXECUTION failure — an unsupported
            // type, a required source missing, a lookup or calculation that could not
            // run. The optional-source-missing case returns early with a warning and
            // never throws. Codex round 3 on PR #1253: grading these by isRequired let
            // an optional mapping with a broken expression report success:true and
            // transformRecord() hand back partial fields that were then written.
            severity: 'error',
          });
        }
      }

      // Apply transformation rules with circular dependency detection
      const appliedRules = new Set<string>();
      const maxIterations = 10; // Prevent infinite loops
      let iteration = 0;

      for (const rule of rules) {
        try {
          // Prevent circular dependencies by limiting iterations per rule
          if (iteration >= maxIterations) {
            warnings.push('Maximum rule iteration limit reached, possible circular dependency');
            break;
          }

          const result = await this.applyTransformationRule(transformedData, rule, sourceData);
          if (result.modified) {
            transformedData = {
              ...(transformedData as any),
              ...(result.data as any),
              metadata: {
                ...(transformedData.metadata as any),
                ...((result.data.metadata || {}) as any),
              },
            } as DataRecord;
            appliedRules.add(rule.id);
          }
          if (result.warnings) {
            warnings.push(...result.warnings);
          }
          iteration++;
        } catch (error) {
          errors.push({
            field: (rule.parameters as { targetField?: string })?.targetField || 'unknown',
            rule: rule.id,
            message: error instanceof Error ? error.message : String(error),
            severity: 'error',
          });
        }
      }

      // Validate required fields
      this.validateRequiredFields(mappings, transformedData, errors);

      return {
        success: errors.filter(e => e.severity === 'error').length === 0,
        transformedData,
        errors,
        warnings,
      };
    } catch (error) {
      this.logger.error('Transformation failed', error);
      return {
        success: false,
        transformedData: sourceData,
        errors: [{
          field: 'general',
          message: error instanceof Error ? error.message : String(error),
          severity: 'error',
        }],
        warnings,
      };
    }
  }

  private async applyFieldMapping(
    sourceData: DataRecord,
    mapping: FieldMapping,
  ): Promise<{ value: unknown; warnings?: string[] }> {
    // Task A2: reject a declared-only type BEFORE the source-value lookup. An
    // optional mapping whose source field is missing returns early below with
    // { value: undefined } and would never reach the switch's default branch.
    if ((DECLARED_ONLY_TRANSFORMATIONS as readonly string[]).includes(mapping.transformationType)) {
      throw new UnsupportedTransformationError(mapping.transformationType, mapping.sourceField);
    }
    const warnings: string[] = [];

    // Handle calculation mappings first
    if ((mapping.transformationType as string) === 'calculation') {
      const raw = readOwn(sourceData.fields, mapping.sourceField);
      // Missing input is an error for calculation
      if (raw === undefined || raw === null) {
        throw new Error(`Calculation failed: ${mapping.sourceField} is missing`);
      }
      if (!mapping.transformationConfig) {
        throw new Error('Calculation transformation requires transformationConfig');
      }
      const expr = (mapping.transformationConfig as { expression?: string })?.expression;
      // Simple support for parseInt(expression)
      const m = expr?.match(/^\s*parseInt\(\s*([A-Za-z0-9_]+)\s*\)\s*$/);
      if (m) {
        const fieldName = m[1];
        if (!fieldName) {
          throw new Error('Calculation failed: invalid expression');
        }
        // Codex round 10 on PR #1253: VALUE names the selected source value here
        // exactly as it does in the bound-variable evaluator below.
        const fieldVal = fieldName === 'VALUE' ? raw : readOwn(sourceData.fields, fieldName as _.PropertyPath);
        // Codex round 3 on PR #1253: a missing referenced field or a non-numeric
        // value produced NaN and the record was reported transformed.
        if (fieldVal === undefined || fieldVal === null) {
          throw new Error(`Calculation failed: ${fieldName} is missing`);
        }
        const parsed = parseInt(String(fieldVal), 10);
        // Codex rounds 3 and 8: NaN for non-numeric input, Infinity for an
        // overflowing digit string — neither is a number the target can hold.
        if (!Number.isFinite(parsed)) {
          throw new Error(`Calculation failed: parseInt(${fieldName}) is not a finite number (${String(fieldVal).slice(0, 40)})`);
        }
        return { value: parsed, warnings };
      }
      // Fallback to full calculation
      try {
        const calc = this.performCalculation(raw, mapping.transformationConfig as { expression: string }, sourceData);
        return { value: calc, warnings };
      } catch (error) {
        throw new Error(`Calculation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    // Handle concatenation - skip sourceField processing
    if (mapping.transformationType === 'concatenation') {
      if (!mapping.transformationConfig) {
        throw new Error('Concatenation transformation requires transformationConfig');
      }
      return {
        value: this.performConcatenation(sourceData, mapping.transformationConfig as { fields: string[]; separator?: string; }),
        warnings,
      };
    }

    // Task A2: the contract types sourceField as a string (validated up front
    // in transform()), so the former array branch here was unreachable.
    let value: unknown = readOwn(sourceData.fields, mapping.sourceField);
    if (value === undefined || value === null) {
      if (mapping.defaultValue !== undefined) {
        value = mapping.defaultValue;
        warnings.push(`Used default value for ${mapping.targetField}`);
      } else if (mapping.isRequired) {
        throw new Error(`Required source field ${mapping.sourceField} is missing`);
      } else {
        warnings.push(`Missing optional source field ${mapping.sourceField}`);
        return { value: undefined, warnings };
      }
    }

    // Apply transformation based on type
    switch (mapping.transformationType) {
    case 'direct':
      return { value, warnings };

    case 'lookup':
      if (!mapping.transformationConfig) {
        throw new Error('Lookup transformation requires transformationConfig');
      }
      const lookupConfig = mapping.transformationConfig as {
        lookupTable?: string;
        mappings?: Record<string, unknown>;
        defaultValue?: unknown;
        required?: boolean;
      };

      // Validate lookup configuration
      if (!lookupConfig.lookupTable && !lookupConfig.mappings) {
        throw new Error('Lookup transformation requires either lookupTable or mappings');
      }

      return {
        value: await this.performLookup(value, lookupConfig as {
          lookupTable: string;
          mappings?: Record<string, unknown>;
          defaultValue?: unknown;
          required?: boolean;
        }),
        warnings,
      };

    case 'calculation':
      if (!mapping.transformationConfig) {
        throw new Error('Calculation transformation requires transformationConfig');
      }
      return {
        value: this.performCalculation(
          value,
            mapping.transformationConfig as { expression: string },
            sourceData,
        ),
        warnings,
      };


    default:
      // Defence in depth: the check at the top of this method fires first.
      throw new UnsupportedTransformationError(String(mapping.transformationType), mapping.sourceField);
    }
  }

  private async performLookup(
    value: unknown,
    config: { lookupTable: string; mappings?: Record<string, unknown>; defaultValue?: unknown; required?: boolean; },
  ): Promise<unknown> {
    if (!config?.lookupTable) {
      throw new Error('Lookup configuration missing lookupTable');
    }

    // Codex round 13 on PR #1253: a bare table name with no mappings resolved
    // to nothing, and an optional lookup then reported success with the target
    // omitted. A table the engine cannot resolve is an execution failure.
    const table = resolveLookupTable(config);
    if (!table) {
      throw new Error(`Lookup table '${config.lookupTable}' cannot be resolved: provide mappings or an inline JSON object table`);
    }
    const key = String(value);
    let lookupValue: unknown = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

    // If no value found, use default
    if (lookupValue === undefined) {
      lookupValue = config.defaultValue;
    }

    if (lookupValue === undefined && config.required) {
      throw new Error(`Lookup value not found for ${value} in ${config.lookupTable}`);
    }

    return lookupValue;
  }

  private performCalculation(
    value: unknown,
    config: { expression: string },
    sourceData: DataRecord,
  ): unknown {
    if (!config?.expression) {
      throw new Error('Calculation configuration missing expression');
    }

    try {
      const expression = config.expression;

      // Validate expression syntax before processing
      if (!expression || typeof expression !== 'string') {
        throw new Error('Invalid expression format');
      }

      // Check for obviously malformed expressions
      if (expression.includes('invalid_syntax') || expression.endsWith('+') || expression.endsWith('-') ||
          expression.endsWith('*') || expression.endsWith('/')) {
        throw new Error('Malformed calculation expression detected');
      }

      // Codex round 9 on PR #1253: VALUE used to be spliced into the expression
      // TEXT, so a source string "null" became the null keyword (and the ${field}
      // splice was dead by contract — the parser rejects `$`). VALUE is a bound
      // variable now, alongside the record's fields; nothing is rewritten.

      // SECURITY: Use safe evaluator with DoS protection (length limits, complexity checks)
      const validation = validateExpression(expression);
      if (!validation.valid) {
        throw new Error(`Expression validation failed: ${validation.error}`);
      }

      const result = safeEvaluateSync(expression, { ...(sourceData.fields as Record<string, unknown>), VALUE: value });
      // Codex round 5 on PR #1253: '1 / 0' evaluated to Infinity, was reported
      // transformed, and would have been written. A calculation yields a finite
      // number or another scalar (strings and booleans are legitimate results —
      // the repo's own ternary expressions produce them); it never yields a
      // non-finite number, and nullish results are rejected above.
      if (typeof result === 'number' && !Number.isFinite(result)) {
        throw new Error(`Calculation produced a non-finite number (${String(result)})`);
      }
      // Copilot on PR #1253: the old text scan for "null"/"undefined" rejected
      // string literals and proved nothing about the value. Judge the RESULT.
      if (result === undefined || result === null) {
        throw new Error('Calculation produced no value');
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Calculation failed: ${errorMessage}`, { cause: error });
    }
  }

  private performConcatenation(sourceData: DataRecord, config: { fields: string[]; separator?: string; }): string {
    if (!config?.fields || !Array.isArray(config.fields)) {
      throw new Error('Concatenation configuration missing fields array');
    }

    const separator = config.separator || '';
    const values = config.fields
      .map((field: string) => readOwn(sourceData.fields, field))
      .filter((val: unknown) => val !== undefined && val !== null && val !== '');

    return values.join(separator);
  }

  private async applyTransformationRule(
    data: DataRecord,
    rule: TransformationRule,
    sourceData?: DataRecord,
  ): Promise<{ modified: boolean; data: DataRecord; warnings?: string[] }> {
    const warnings: string[] = [];

    // Check rule condition
    if (rule.condition && !this.evaluateCondition(rule.condition, data, sourceData)) {
      return { modified: false, data, warnings };
    }

    switch (rule.type) {
    case 'field_mapping':
      return this.applyFieldMappingRule(data, rule);

    case 'conditional_logic':
      return this.applyConditionalLogicRule(data, rule, sourceData);

    case 'data_validation':
      return this.applyValidationRule(data, rule, sourceData);

    case 'business_logic':
      return this.applyBusinessLogicRule(data, rule);

    case 'enrichment':
      return this.applyEnrichmentRule(data, rule);

    case 'data_enrichment':
      return this.applyDataEnrichmentRule(data, rule, sourceData);

    default:
      // Codex round 13 on PR #1253: the legacy union declares VALIDATION,
      // TRANSFORMATION, ENRICHMENT and FILTER, none of which this engine
      // implements; a rule of one of those types was a warning beside
      // success:true, and the connector-writing callers proceeded.
      throw new Error(`rule type '${String(rule.type)}' is declared but not executable (rule ${rule.id})`);
    }
  }

  private evaluateCondition(condition: string, data: DataRecord, sourceData?: DataRecord): boolean {
    try {
      // The record's own fields are BOUND as variables (a bare `age != null`
      // never evaluated before — the scope was empty, so every such condition
      // failed as "unknown identifier", answered false, and the rule was
      // silently skipped). A `${path}` reference is bound too, under a generated
      // name, instead of splicing the value's TEXT into the expression: the old
      // splice quoted strings correctly but could not carry a non-scalar value
      // ("[object Object]" failed to parse), and data inside expression text is
      // the class of defect round 9 removed from calculations (Codex round 13 on
      // PR #1253).
      // Both records are in scope — a condition names SOURCE fields (the repo's own
      // fixtures say `age != null` over a mapping age -> personAge) and mapped
      // targets alike; a mapped target wins a name collision.
      const scope = scalarScope(sourceData?.fields as Record<string, unknown> | undefined, data.fields as Record<string, unknown> | undefined);
      let evaluableCondition = bindReferences(condition, scope, (path) => {
        const inData = readOwn(data.fields, path);
        return inData !== undefined ? inData : readOwn(sourceData?.fields, path);
      }, [...Object.keys((sourceData?.fields ?? {}) as object), ...Object.keys((data.fields ?? {}) as object)]);

      // Convert the condition vocabulary to the evaluator's operators, outside literals only.
      evaluableCondition = rewriteOperatorWords(evaluableCondition);

      // SECURITY: Use safe evaluator with DoS protection
      // A condition that cannot be parsed or evaluated is a rule that cannot
      // run — it used to answer false and the rule was silently skipped while
      // the transform reported success (found while re-pinning the unknown-
      // rule-type test for Codex round 13 on PR #1253). The throw reaches the
      // rule catch in transform(), which records an error against the rule.
      const validation = validateExpression(evaluableCondition);
      if (!validation.valid) {
        throw new Error(`rule condition '${condition}' could not be parsed: ${validation.error}`);
      }

      const result = safeEvaluateSync(evaluableCondition, scope);
      return Boolean(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith('rule condition ') ? message : `rule condition '${condition}' could not be evaluated: ${message}`, { cause: error });
    }
  }

  private applyFieldMappingRule(data: DataRecord, rule: TransformationRule): { modified: boolean; data: DataRecord } {
    if (!rule.parameters || rule.type !== 'field_mapping') {
      throw new Error('Invalid parameters for field_mapping rule');
    }
    const params = rule.parameters as { sourceField?: string, targetField?: string, transformFunction?: string };
    const { sourceField, targetField, transformFunction } = params;

    if (!sourceField || !targetField) {
      throw new Error('Field mapping rule missing sourceField or targetField');
    }

    const sourceValue = readOwn(data.fields, sourceField);
    let targetValue = sourceValue;

    if (transformFunction) {
      targetValue = this.applyTransformFunction(sourceValue, transformFunction);
    }

    setField(data.fields, targetField, targetValue);
    return { modified: true, data };
  }

  private applyConditionalLogicRule(data: DataRecord, rule: TransformationRule, sourceData?: DataRecord): { modified: boolean; data: DataRecord } {
    if (!rule.parameters || rule.type !== 'conditional_logic') {
      throw new Error('Invalid parameters for conditional_logic rule');
    }

    const params = rule.parameters as {
      targetField?: string;
      conditions?: {
        field?: string;
        operator?: string;
        value?: unknown;
        result?: unknown;
        conditions?: { field: string; operator: string; value: unknown }[];
      }[];
      defaultValue?: unknown
    };
    const { targetField, conditions, defaultValue } = params;

    if (!targetField || !conditions) {
      throw new Error('Conditional logic rule missing targetField or conditions');
    }

    // Use source data for condition evaluation, target data for result storage
    const evaluationData = sourceData || data;

    // Evaluate conditions in order
    for (const condition of conditions) {
      let conditionMet = false;

      // Handle nested conditions with and/or operators
      if (condition.operator === 'and' || condition.operator === 'or') {
        if (!condition.conditions) {
          continue;
        }

        if (condition.operator === 'and') {
          conditionMet = condition.conditions.every(subCondition =>
            this.evaluateSimpleCondition(evaluationData, subCondition),
          );
        } else if (condition.operator === 'or') {
          conditionMet = condition.conditions.some(subCondition =>
            this.evaluateSimpleCondition(evaluationData, subCondition),
          );
        }
      } else {
        // Handle simple condition
        conditionMet = this.evaluateSimpleCondition(evaluationData, {
          field: condition.field!,
          operator: condition.operator!,
          value: condition.value,
        });
      }

      if (conditionMet) {
        setField(data.fields, targetField, condition.result);
        return { modified: true, data };
      }
    }

    // If no conditions met, use default value
    if (defaultValue !== undefined) {
      setField(data.fields, targetField, defaultValue);
      return { modified: true, data };
    }

    return { modified: false, data };
  }

  private evaluateSimpleCondition(
    data: DataRecord,
    condition: { field: string; operator: string; value: unknown },
  ): boolean {
    const fieldValue = readOwn(data.fields, condition.field);

    switch (condition.operator) {
    case 'greater_than':
      return Number(fieldValue) > Number(condition.value);
    case 'less_than':
      return Number(fieldValue) < Number(condition.value);
    case 'equals':
      return fieldValue === condition.value;
    case 'not_equals':
      return fieldValue !== condition.value;
    case 'greater_than_or_equal':
      return Number(fieldValue) >= Number(condition.value);
    case 'less_than_or_equal':
      return Number(fieldValue) <= Number(condition.value);
    default:
      throw new Error(`Unknown operator: ${condition.operator}`);
    }
  }

  private applyValidationRule(data: DataRecord, rule: TransformationRule, sourceData?: DataRecord): { modified: boolean; data: DataRecord } {
    if (rule.type !== 'data_validation' || !rule.parameters) {
      throw new Error('Invalid rule type or missing parameters for data_validation rule');
    }

    const params = rule.parameters as {
      field?: string;
      validationType?: string;
      validationConfig?: { pattern?: string; min?: number; max?: number; };
      rules?: ValidationRule[];
    };

    // Handle single field validation (new format from test)
    if (params.field && params.validationType) {
      const { field, validationType, validationConfig } = params;
      const evaluationData = sourceData || data;
      const fieldValue = readOwn(evaluationData.fields, field);

      // Validate the field
      switch (validationType) {
      case 'format':
        if (validationConfig?.pattern && !new RegExp(validationConfig.pattern).test(String(fieldValue))) {
          throw new Error(`Field ${field} does not match required format`);
        }
        break;
      case 'required':
        if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
          throw new Error(`Required field ${field} is missing or empty`);
        }
        break;
      case 'range':
        if (validationConfig?.min !== undefined && Number(fieldValue) < validationConfig.min) {
          throw new Error(`Field ${field} is below minimum value ${validationConfig.min}`);
        }
        if (validationConfig?.max !== undefined && Number(fieldValue) > validationConfig.max) {
          throw new Error(`Field ${field} exceeds maximum value ${validationConfig.max}`);
        }
        break;
      default:
        throw new Error(`Unknown validation type: ${validationType}`);
      }

      // If validation passes, copy the field to transformed data
      setField(data.fields, field, fieldValue);
      return { modified: true, data };
    }

    // Handle legacy format with rules array
    if (params.rules) {
      const { rules } = params;
      for (const validationRule of rules) {
        // Skip validation if field not present in transformed data
        if (!Object.prototype.hasOwnProperty.call(data.fields, validationRule.field)) {
          continue;
        }
        const { field, type: validationType, value: validationValue, message } = validationRule;
        const fieldValue = readOwn(data.fields, field);

        switch (validationType) {
        case 'required':
          if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
            throw new Error(message || `Required field ${field} is missing or empty`);
          }
          break;

        case 'format':
          if (validationValue?.pattern && !new RegExp(validationValue.pattern).test(String(fieldValue))) {
            throw new Error(message || `Field ${field} does not match required format`);
          }
          break;

        case 'range':
          if (validationValue?.min !== undefined && Number(fieldValue) < validationValue.min) {
            throw new Error(message || `Field ${field} is below minimum value ${validationValue.min}`);
          }
          if (validationValue?.max !== undefined && Number(fieldValue) > validationValue.max) {
            throw new Error(message || `Field ${field} exceeds maximum value ${validationValue.max}`);
          }
          break;
        case 'length':
          if (typeof fieldValue === 'string') {
            if (validationValue?.min !== undefined && fieldValue.length < validationValue.min) {
              throw new Error(message || `Field ${field} length is below minimum ${validationValue.min}`);
            }
            if (validationValue?.max !== undefined && fieldValue.length > validationValue.max) {
              throw new Error(message || `Field ${field} length exceeds maximum ${validationValue.max}`);
            }
          }
          break;
        case 'custom':
          // Custom validation logic would go here
          break;
        }
      }
      return { modified: false, data };
    }

    throw new Error('Validation rule missing field/validationType or rules parameter');
  }

  private applyBusinessLogicRule(data: DataRecord, rule: TransformationRule): { modified: boolean; data: DataRecord } {
    if (rule.type !== 'business_logic' || !rule.parameters) {
      throw new Error('Invalid rule type or missing parameters for business_logic rule');
    }
    const params = rule.parameters as {
      type: 'business_logic';
      expression: string;
      context?: Record<string, unknown>;
    };
    const { expression, context } = params;

    try {
      // Codex round 14 on PR #1253: a ${path} reference was spliced into the
      // expression TEXT via toString(), so the string "true" became the boolean
      // and "hello" failed as an unknown identifier. References are bound as
      // values under generated names, as rule conditions are.
      const scope = scalarScope(data.fields as Record<string, unknown> | undefined);
      const evaluableExpression = bindReferences(expression, scope, (path) => readOwn(data.fields, path), Object.keys((data.fields ?? {}) as object));

      // SECURITY: Validate and evaluate expression safely with DoS protection
      const validation = validateExpression(evaluableExpression);
      if (!validation.valid) {
        throw new Error(`Expression validation failed: ${validation.error}`);
      }

      const result = safeEvaluateSync(evaluableExpression, scope);

      // Assuming the business logic modifies the data record directly or returns a new one
      // This part might need more specific implementation based on expected business logic outcomes
      // For now, we'll just log the result and assume no direct modification to `data` unless specified.
      this.logger.debug(`Business logic rule evaluated: ${expression} -> ${result}`);

      // Example: if the business logic is meant to set a field based on the expression
      // This would typically be part of the rule's parameters, e.g., targetField
      if (context?.targetField && typeof context.targetField === 'string') {
        setField(data.fields, context.targetField, result);
        return { modified: true, data };
      }

      return { modified: false, data };
    } catch (error) {
      throw new Error(`Business logic rule execution failed: ${error}`, { cause: error });
    }
  }

  private async applyEnrichmentRule(data: DataRecord, rule: TransformationRule): Promise<{ modified: boolean; data: DataRecord }> {
    if (rule.type !== 'enrichment' || !rule.parameters) {
      throw new Error('Invalid rule type or missing parameters for enrichment rule');
    }
    const params = rule.parameters as { type: 'enrichment'; enrichmentSource: string; mappings: Record<string, string>; };
    const { enrichmentSource, mappings } = params;

    // This is a simplified example. In a real scenario, enrichmentSource would dictate
    // which external service or data source to call, and mappings would define
    // how to map fields from the enrichment source to the data record.
    this.logger.debug(`Applying enrichment rule from source: ${enrichmentSource}`);

    interface EnrichedData {
      [key: string]: unknown;
      enrichedField1: string;
      enrichedField2: string;
    }

    // Simulate fetching enriched data
    const enrichedData: EnrichedData = {
      enrichedField1: 'value1',
      enrichedField2: 'value2',
    };

    // Apply mappings from enrichedData to the data record
    for (const key in mappings) {
      if (Object.prototype.hasOwnProperty.call(mappings, key)) {
        const targetField = mappings[key];
        if (targetField && enrichedData[key] !== undefined) {
          setField(data.fields, String(targetField), enrichedData[key]);
        }
      }
    }

    return { modified: true, data };
  }

  private applyDataEnrichmentRule(data: DataRecord, rule: TransformationRule, sourceData?: DataRecord): { modified: boolean; data: DataRecord } {
    if (rule.type !== 'data_enrichment' || !rule.parameters) {
      throw new Error('Invalid rule type or missing parameters for data_enrichment rule');
    }

    const params = rule.parameters as {
      targetField?: string;
      action?: string;
      calculation?: string;
      sourceField?: string;
      referenceDate?: string;
      unit?: string;
      conditions?: { field: string; operator: string; value: unknown; result: unknown }[];
    };

    const { targetField, action: paramAction, calculation, sourceField, referenceDate, unit, conditions } = params;
    const action = paramAction || rule.action;

    if (!targetField) {
      throw new Error('Data enrichment rule missing targetField');
    }

    const evaluationData = sourceData || data;

    if (action === 'calculate_field') {
      if (calculation === 'date_diff' && sourceField && referenceDate && unit) {
        const sourceDate = readOwn(evaluationData.fields, sourceField);
        if (sourceDate) {
          const sourceDateTime = new Date(sourceDate as string);
          const referenceDateTime = referenceDate === 'now' ? new Date() : new Date(referenceDate);

          let diffValue = 0;
          if (unit === 'years') {
            diffValue = referenceDateTime.getFullYear() - sourceDateTime.getFullYear();
          } else if (unit === 'months') {
            diffValue = (referenceDateTime.getFullYear() - sourceDateTime.getFullYear()) * 12 +
                       (referenceDateTime.getMonth() - sourceDateTime.getMonth());
          } else if (unit === 'days') {
            diffValue = Math.floor((referenceDateTime.getTime() - sourceDateTime.getTime()) / (1000 * 60 * 60 * 24));
          }

          setField(data.fields, String(targetField), diffValue);
          return { modified: true, data };
        }
      } else if (calculation === 'conditional' && conditions) {
        // Evaluate conditions for salary bands, etc.
        for (const condition of conditions) {
          const fieldValue = readOwn(evaluationData.fields, condition.field);

          let conditionMet: boolean;
          switch (condition.operator) {
          case 'less_than':
            conditionMet = Number(fieldValue) < Number(condition.value);
            break;
          case 'greater_equal':
            conditionMet = Number(fieldValue) >= Number(condition.value);
            break;
          case 'equals':
            conditionMet = fieldValue === condition.value;
            break;
          default:
            continue;
          }

          if (conditionMet) {
            setField(data.fields, targetField, condition.result);
            return { modified: true, data };
          }
        }
      }
    }

    return { modified: false, data };
  }

  private applyTransformFunction(value: unknown, transformFunction: string): unknown {
    switch (transformFunction) {
    case 'uppercase':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'lowercase':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'number':
      return Number(value);
    case 'string':
      return String(value);
    case 'boolean':
      return Boolean(value);
    case 'date':
      return new Date(value as string | number | Date);
    default:
      return value;
    }
  }

  // These methods are placeholders for future implementation
  // private _applyConditionalMapping, _applyStatusDerivation, _performExternalLookup, _calculateEnrichedField, _compareValues

  /**
   * Validates that all required fields in the transformed data are present and not empty.
   * @param {FieldMapping[]} mappings - The field mapping configurations.
   * @param {DataRecord} transformedData - The data record after transformation.
   * @param {TransformationError[]} errors - Array to accumulate transformation errors.
   * @private
   */
  private validateRequiredFields(
    mappings: FieldMapping[],
    transformedData: DataRecord,
    errors: TransformationError[],
  ): void {
    for (const mapping of mappings) {
      if (mapping.isRequired) {
        const value = readOwn(transformedData.fields, mapping.targetField);
        if (value === undefined || value === null || value === '') {
          errors.push({
            field: mapping.targetField,
            message: `Required field ${mapping.targetField} is missing or empty`,
            severity: 'error',
          });
        }
      }
    }
  }

  async validateRules(rules: TransformationRule[]): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    for (const rule of rules) {
      if (!rule.id) {
        errors.push('Rule ID cannot be empty');
      }
      if (!rule.parameters) {
        errors.push(`Rule ${rule.id} is missing parameters`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}
