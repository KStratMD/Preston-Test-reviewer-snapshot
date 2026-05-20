import type { Logger } from "./Logger";
import type { DataRecord } from "../types";
import { safeEvaluateSync, validateExpression } from "./safeExprEval";

export interface FieldMappingMetadata {
  sourceSystem: string;
  targetSystem: string;
  module: string;
  recordType: string;
  mappings: {
    sourceField: string;
    targetField: string;
    transformation?: "direct" | "lookup" | "calculation" | "concatenation" | "conditional";
    transformationValue?: string;
    required: boolean;
    description?: string;
  }[];
}

export interface MappingResult {
  success: boolean;
  mappedRecord?: DataRecord;
  errors: string[];
  warnings: string[];
  unmappedFields: string[];
}

export class FieldMapperUtility {
  constructor(private logger: Logger) {}

  /**
   * Apply field mappings from source to target system using metadata
   */
  async mapFields(
    sourceRecord: DataRecord,
    metadata: FieldMappingMetadata,
  ): Promise<MappingResult> {
    const result: MappingResult = {
      success: true,
      mappedRecord: {},
      errors: [],
      warnings: [],
      unmappedFields: [],
    };

    this.logger.info("Starting field mapping", {
      sourceSystem: metadata.sourceSystem,
      targetSystem: metadata.targetSystem,
      module: metadata.module,
      mappingCount: metadata.mappings.length,
    });

    try {
      // Track which source fields were mapped
      const mappedSourceFields = new Set<string>();

      // Process each mapping
      for (const mapping of metadata.mappings) {
        try {
          const mappedValue = await this.transformField(
            sourceRecord,
            mapping,
            metadata,
          );

          if (mappedValue !== undefined && mappedValue !== null) {
            result.mappedRecord![mapping.targetField] = mappedValue;
            mappedSourceFields.add(mapping.sourceField);
          } else if (mapping.required) {
            result.errors.push(
              `Required field ${mapping.targetField} could not be mapped from ${mapping.sourceField}`,
            );
            result.success = false;
          } else {
            result.warnings.push(
              `Optional field ${mapping.targetField} has no value from ${mapping.sourceField}`,
            );
          }
        } catch (error) {
          const errorMsg = `Failed to map ${mapping.sourceField} -> ${mapping.targetField}: ${error instanceof Error ? error.message : String(error)}`;
          result.errors.push(errorMsg);
          if (mapping.required) {
            result.success = false;
          }
        }
      }

      // Identify unmapped source fields
      const allSourceFields = Object.keys(sourceRecord);
      result.unmappedFields = allSourceFields.filter(
        field => !mappedSourceFields.has(field),
      );

      this.logger.info("Field mapping completed", {
        success: result.success,
        mappedFields: Object.keys(result.mappedRecord || {}).length,
        errors: result.errors.length,
        warnings: result.warnings.length,
        unmappedFields: result.unmappedFields.length,
      });

      return result;
    } catch (error) {
      result.success = false;
      result.errors.push(
        `Field mapping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger.error("Field mapping failed", error);
      return result;
    }
  }

  /**
   * Transform a single field value based on mapping configuration
   */
  private async transformField(
    sourceRecord: DataRecord,
    mapping: FieldMappingMetadata["mappings"][0],
    metadata: FieldMappingMetadata,
  ): Promise<unknown> {
    const sourceValue = sourceRecord[mapping.sourceField];

    // Handle null/undefined source values
    if (sourceValue === null || sourceValue === undefined) {
      return null;
    }

    switch (mapping.transformation) {
    case "direct":
      return sourceValue;

    case "lookup":
      return this.performLookupTransformation(
        sourceValue,
        mapping.transformationValue,
        metadata,
      );

    case "calculation":
      return this.performCalculationTransformation(
        sourceRecord,
        mapping.transformationValue,
        metadata,
      );

    case "concatenation":
      return this.performConcatenationTransformation(
        sourceRecord,
        mapping.transformationValue,
        metadata,
      );

    case "conditional":
      return this.performConditionalTransformation(
        sourceRecord,
        mapping.transformationValue,
        metadata,
      );

    default:
      // Default to direct mapping if no transformation specified
      return sourceValue;
    }
  }

  /**
   * Perform lookup transformation using mapping tables
   */
  private async performLookupTransformation(
    sourceValue: unknown,
    transformationValue: string | undefined,
    metadata: FieldMappingMetadata,
  ): Promise<unknown> {
    if (!transformationValue) {
      this.logger.warn("Lookup transformation missing value", { metadata });
      return sourceValue;
    }

    try {
      // Parse lookup table from transformation value
      const lookupTable = JSON.parse(transformationValue) as Record<string, unknown>;
      const key = String(sourceValue);

      if (key in lookupTable) {
        return lookupTable[key];
      }

      // Check for default value
      if ("_default" in lookupTable) {
        return lookupTable._default;
      }

      this.logger.warn("Lookup value not found", {
        sourceValue,
        availableKeys: Object.keys(lookupTable),
      });
      return sourceValue;
    } catch (error) {
      this.logger.error("Lookup transformation failed", {
        error,
        transformationValue,
        sourceValue,
      });
      return sourceValue;
    }
  }

  /**
   * Perform calculation transformation using field expressions
   */
  private async performCalculationTransformation(
    sourceRecord: DataRecord,
    transformationValue: string | undefined,
    _metadata: FieldMappingMetadata,
  ): Promise<unknown> {
    if (!transformationValue) {
      return null;
    }

    try {
      // Convert placeholders like {amount} to identifiers usable by expr-eval
      // Build variables map from sourceRecord. Non-numeric values default to 0.
      const vars: Record<string, number> = {};
      for (const key of Object.keys(sourceRecord)) {
        const v = (sourceRecord as Record<string, unknown>)[key];
        const num = typeof v === "number" ? v : parseFloat(String(v));
        vars[key] = Number.isFinite(num) ? num : 0;
      }

      // Replace {field} with field for parser compatibility
      const expression = transformationValue.replace(/\{(\w+)\}/g, (_m, g1) => g1);

      // SECURITY: Validate and evaluate expression safely with DoS protection
      const validation = validateExpression(expression);
      if (!validation.valid) {
        this.logger.warn("Expression validation failed", {
          error: validation.error,
          transformationValue,
        });
        return 0;
      }

      const result = safeEvaluateSync(expression, vars);
      return typeof result === "number" && Number.isFinite(result) ? result : 0;
    } catch (error) {
      this.logger.error("Calculation transformation failed", {
        error,
        transformationValue,
      });
      return 0;
    }
  }

  /**
   * Perform concatenation transformation using field templates
   */
  private async performConcatenationTransformation(
    sourceRecord: DataRecord,
    transformationValue: string | undefined,
    _metadata: FieldMappingMetadata,
  ): Promise<string> {
    if (!transformationValue) {
      return "";
    }

    try {
      let result = transformationValue;

      // Replace field placeholders with actual values
      Object.keys(sourceRecord).forEach(fieldName => {
        const fieldValue = sourceRecord[fieldName] || "";
        result = result.replace(
          new RegExp(`\\{${fieldName}\\}`, "g"),
          String(fieldValue),
        );
      });

      return result.trim();
    } catch (error) {
      this.logger.error("Concatenation transformation failed", {
        error,
        transformationValue,
      });
      return "";
    }
  }

  /**
   * Perform conditional transformation using if-then logic
   */
  private async performConditionalTransformation(
    sourceRecord: DataRecord,
    transformationValue: string | undefined,
    _metadata: FieldMappingMetadata,
  ): Promise<unknown> {
    if (!transformationValue) {
      return null;
    }

    try {
      // Parse conditional logic: "if {field} == 'value' then 'result' else 'default'"
      const conditionalRegex = /if\s+\{(\w+)\}\s*(==|!=|>|<|>=|<=)\s*'([^']+)'\s+then\s+'([^']+)'\s+else\s+'([^']+)'/i;
      const match = transformationValue.match(conditionalRegex);

      if (!match) {
        throw new Error("Invalid conditional expression format");
      }

      const [, fieldName, operator, compareValue, thenValue, elseValue] = match;

      if (!fieldName || !operator || !compareValue || !thenValue || !elseValue) {
        throw new Error("Invalid conditional expression: missing required components");
      }

      const fieldValue = String(sourceRecord[fieldName] || "");

      let condition = false;
      switch (operator) {
      case "==":
        condition = fieldValue === compareValue;
        break;
      case "!=":
        condition = fieldValue !== compareValue;
        break;
      case ">":
        condition = parseFloat(fieldValue) > parseFloat(compareValue);
        break;
      case "<":
        condition = parseFloat(fieldValue) < parseFloat(compareValue);
        break;
      case ">=":
        condition = parseFloat(fieldValue) >= parseFloat(compareValue);
        break;
      case "<=":
        condition = parseFloat(fieldValue) <= parseFloat(compareValue);
        break;
      default:
        condition = false;
      }

      return condition ? thenValue : elseValue;
    } catch (error) {
      this.logger.error("Conditional transformation failed", {
        error,
        transformationValue,
      });
      return null;
    }
  }

  /**
   * Validate field mapping metadata for completeness and consistency
   */
  validateMappingMetadata(metadata: FieldMappingMetadata): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!metadata.sourceSystem) errors.push("sourceSystem is required");
    if (!metadata.targetSystem) errors.push("targetSystem is required");
    if (!metadata.module) errors.push("module is required");
    if (!metadata.recordType) errors.push("recordType is required");
    if (!metadata.mappings || metadata.mappings.length === 0) {
      errors.push("mappings array is required and cannot be empty");
    }

    // Validate individual mappings
    metadata.mappings?.forEach((mapping, index) => {
      if (!mapping.sourceField) {
        errors.push(`Mapping ${index}: sourceField is required`);
      }
      if (!mapping.targetField) {
        errors.push(`Mapping ${index}: targetField is required`);
      }

      // Check for transformation consistency
      if (mapping.transformation && !mapping.transformationValue) {
        if (mapping.transformation !== "direct") {
          warnings.push(
            `Mapping ${index}: ${mapping.transformation} transformation specified but no transformationValue provided`,
          );
        }
      }
    });

    // Check for duplicate target fields
    const targetFields = metadata.mappings?.map(m => m.targetField) || [];
    const duplicates = targetFields.filter(
      (field, index) => targetFields.indexOf(field) !== index,
    );
    if (duplicates.length > 0) {
      warnings.push(`Duplicate target fields found: ${duplicates.join(", ")}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Generate sample mapping metadata for a given module
   */
  generateSampleMapping(
    sourceSystem: string,
    targetSystem: string,
    module: string,
    recordType: string,
  ): FieldMappingMetadata {
    // Return sample mappings based on common patterns
    const baseMappings: FieldMappingMetadata = {
      sourceSystem,
      targetSystem,
      module,
      recordType,
      mappings: [
        {
          sourceField: "id",
          targetField: "externalId",
          transformation: "direct",
          required: true,
          description: "Direct ID mapping for record identification",
        },
        {
          sourceField: "name",
          targetField: "displayName",
          transformation: "direct",
          required: true,
          description: "Direct name field mapping",
        },
        {
          sourceField: "email",
          targetField: "primaryEmail",
          transformation: "direct",
          required: false,
          description: "Email address mapping",
        },
        {
          sourceField: "status",
          targetField: "isActive",
          transformation: "lookup",
          transformationValue: "{\"active\": true, \"inactive\": false, \"_default\": true}",
          required: true,
          description: "Status mapping with lookup table",
        },
      ],
    };

    this.logger.info("Generated sample mapping", {
      sourceSystem,
      targetSystem,
      module,
      mappingCount: baseMappings.mappings.length,
    });

    return baseMappings;
  }
}
