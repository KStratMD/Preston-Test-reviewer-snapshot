/**
 * Business Intelligence Implementation Types
 * Implementation plans, phases, resources, and milestones
 */

export interface ImplementationPlan {
  phases: ImplementationPhase[];
  totalDuration: number; // days
  totalCost: number;
  resourceRequirements: ResourceRequirement[];
  milestones: Milestone[];
  riskMitigation: string[];
}

export interface ImplementationPhase {
  phaseNumber: number;
  name: string;
  description: string;
  duration: number; // days
  cost: number;
  deliverables: string[];
  dependencies: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ResourceRequirement {
  type: 'human' | 'technical' | 'financial' | 'vendor' | 'business'; // Added 'business' as it was used in BI service
  description: string;
  quantity: number;
  duration: number; // days
  cost?: number;
  unitCost?: number;
  skillsRequired?: string[];
}

export interface Milestone {
  name: string;
  targetDate: Date;
  description: string;
  successCriteria: string[];
  dependencies: string[];
}
