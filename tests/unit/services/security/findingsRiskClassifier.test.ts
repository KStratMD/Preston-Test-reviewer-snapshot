import 'reflect-metadata';
import { classifyFindingsRisk } from '../../../../src/services/security/findingsRiskClassifier';
import type { PIIFinding } from '../../../../src/services/security/DLPService';

describe('findingsRiskClassifier', () => {
  const mockFinding = (type: string, severity: PIIFinding['severity'] = 'low'): PIIFinding => ({
    type,
    value: 'mock-val',
    confidence: 1.0,
    location: { path: 'test' },
    severity,
    redactedValue: '[REDACTED]',
  });

  describe('classifyFindingsRisk', () => {
    it('should return none for empty findings', () => {
      expect(classifyFindingsRisk([])).toBe('none');
    });

    it('should classify high risk for high risk types regardless of severity', () => {
      const highRiskTypes = [
        'ssn',
        'credit_card',
        'bank_account',
        'medical_record_number',
        'passport',
        'drivers_license',
        'api_key',
        'jwt_token',
      ];

      for (const type of highRiskTypes) {
        expect(classifyFindingsRisk([mockFinding(type, 'low')])).toBe('high');
      }
    });

    it('should classify high risk if any finding has critical or high severity', () => {
      expect(classifyFindingsRisk([mockFinding('some_random_type', 'critical')])).toBe('high');
      expect(classifyFindingsRisk([mockFinding('some_random_type', 'high')])).toBe('high');
    });

    it('should classify medium risk for medium risk types if severity is not high/critical', () => {
      const mediumRiskTypes = [
        'phone',
        'phone_intl',
        'date_of_birth',
        'name',
      ];

      for (const type of mediumRiskTypes) {
        expect(classifyFindingsRisk([mockFinding(type, 'low')])).toBe('medium');
      }
    });

    it('should keep unknown medium-severity findings low risk', () => {
      expect(classifyFindingsRisk([mockFinding('email', 'medium')])).toBe('low');
      expect(classifyFindingsRisk([mockFinding('some_random_type', 'medium')])).toBe('low');
    });

    it('should classify low risk for low risk types and severities', () => {
      expect(classifyFindingsRisk([mockFinding('ip_address', 'low')])).toBe('low');
    });

    it('should prioritize highest risk found in the array', () => {
      const mixed = [
        mockFinding('ip_address', 'low'),
        mockFinding('phone', 'low'),
        mockFinding('ssn', 'low'),
      ];
      expect(classifyFindingsRisk(mixed)).toBe('high');

      const mediumAndLow = [
        mockFinding('ip_address', 'low'),
        mockFinding('phone', 'low'),
      ];
      expect(classifyFindingsRisk(mediumAndLow)).toBe('medium');
    });
  });
});
