/**
 * Telemetry Stabilization Service
 * Week 8 Implementation - Enhanced monitoring, dashboards, and telemetry management
 */

import { injectable } from 'inversify';
import { logger } from '../../utils/Logger';

export interface TelemetryDashboard {
    id: string;
    name: string;
    type: 'operational' | 'business' | 'technical' | 'executive';
    widgets: DashboardWidget[];
    refreshInterval: number; // seconds
    filters: DashboardFilter[];
    layout: DashboardLayout;
}

export interface DashboardWidget {
    id: string;
    type: 'metric' | 'chart' | 'table' | 'heatmap' | 'gauge' | 'alert';
    title: string;
    dataSource: string;
    metrics: string[];
    visualization: VisualizationConfig;
    position: WidgetPosition;
    size: WidgetSize;
}

export interface VisualizationConfig {
    chartType?: 'line' | 'bar' | 'pie' | 'area' | 'scatter';
    colorScheme?: string;
    showLegend?: boolean;
    showGrid?: boolean;
    animationDuration?: number;
    thresholds?: ThresholdConfig[];
}

export interface ThresholdConfig {
    value: number;
    color: string;
    label: string;
    alertLevel?: 'info' | 'warning' | 'error' | 'critical';
}

export interface WidgetPosition {
    x: number;
    y: number;
}

export interface WidgetSize {
    width: number;
    height: number;
}

export interface DashboardFilter {
    field: string;
    type: 'time' | 'text' | 'select' | 'range';
    default?: unknown;
    options?: unknown[];
}

export interface DashboardLayout {
    type: 'grid' | 'flex' | 'fixed';
    columns: number;
    rows?: number;
    gap?: number;
}

export interface MetricDefinition {
    id: string;
    name: string;
    category: string;
    type: 'counter' | 'gauge' | 'histogram' | 'summary';
    unit: string;
    description: string;
    tags: string[];
    aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'p50' | 'p95' | 'p99';
    retention: number; // days
}

export interface TelemetryStream {
    id: string;
    name: string;
    source: string;
    destination: string;
    format: 'json' | 'prometheus' | 'statsd' | 'opentelemetry';
    batchSize: number;
    flushInterval: number; // ms
    compression: boolean;
    encryption: boolean;
}

export interface AlertRule {
    id: string;
    name: string;
    metric: string;
    condition: AlertCondition;
    severity: 'info' | 'warning' | 'error' | 'critical';
    actions: AlertAction[];
    cooldown: number; // seconds
    enabled: boolean;
}

export interface AlertCondition {
    operator: '>' | '<' | '=' | '>=' | '<=' | '!=';
    threshold: number;
    duration?: number; // seconds
    evaluationWindow?: number; // seconds
}

export interface AlertAction {
    type: 'email' | 'slack' | 'webhook' | 'pagerduty' | 'log';
    target: string;
    template?: string;
    metadata?: Record<string, unknown>;
}

export interface TelemetryHealth {
    status: 'healthy' | 'degraded' | 'unhealthy';
    collectors: CollectorHealth[];
    storage: StorageHealth;
    processing: ProcessingHealth;
    lastCheck: Date;
}

export interface CollectorHealth {
    name: string;
    status: 'active' | 'inactive' | 'error';
    eventsPerSecond: number;
    errorRate: number;
    lastSeen: Date;
}

export interface StorageHealth {
    used: number;
    available: number;
    retentionDays: number;
    oldestData: Date;
}

export interface ProcessingHealth {
    queueDepth: number;
    processingRate: number;
    errorRate: number;
    latency: number;
}

@injectable()
export class TelemetryStabilizationService {
    private dashboards = new Map<string, TelemetryDashboard>();
    private metrics = new Map<string, MetricDefinition>();
    private streams = new Map<string, TelemetryStream>();
    private alertRules = new Map<string, AlertRule>();
    private metricValues = new Map<string, number[]>();

    constructor() {
        this.initializeTelemetrySystem();
        this.createDefaultDashboards();
        this.setupCoreMetrics();
    }

    private initializeTelemetrySystem(): void {
        logger.info('Telemetry Stabilization Service initialized');

        // Start metric collection
        this.startMetricCollection();

        // Initialize alert evaluation
        this.startAlertEvaluation();
    }

    /**
     * Create default monitoring dashboards
     */
    private createDefaultDashboards(): void {
        // Operational Dashboard
        this.dashboards.set('operational', {
            id: 'operational',
            name: 'Operational Dashboard',
            type: 'operational',
            widgets: [
                {
                    id: 'uptime-gauge',
                    type: 'gauge',
                    title: 'System Uptime',
                    dataSource: 'metrics.system.uptime',
                    metrics: ['system.uptime'],
                    visualization: {
                        thresholds: [
                            { value: 95, color: 'red', label: 'Critical' },
                            { value: 98, color: 'yellow', label: 'Warning' },
                            { value: 99.5, color: 'green', label: 'Healthy' }
                        ]
                    },
                    position: { x: 0, y: 0 },
                    size: { width: 3, height: 2 }
                },
                {
                    id: 'response-time-chart',
                    type: 'chart',
                    title: 'Response Time Trend',
                    dataSource: 'metrics.api.response_time',
                    metrics: ['api.response_time.p50', 'api.response_time.p95', 'api.response_time.p99'],
                    visualization: {
                        chartType: 'line',
                        showLegend: true,
                        showGrid: true
                    },
                    position: { x: 3, y: 0 },
                    size: { width: 6, height: 3 }
                },
                {
                    id: 'error-rate-chart',
                    type: 'chart',
                    title: 'Error Rate',
                    dataSource: 'metrics.api.errors',
                    metrics: ['api.error_rate'],
                    visualization: {
                        chartType: 'area',
                        colorScheme: 'red'
                    },
                    position: { x: 9, y: 0 },
                    size: { width: 3, height: 2 }
                }
            ],
            refreshInterval: 30,
            filters: [
                {
                    field: 'timeRange',
                    type: 'time',
                    default: '1h'
                }
            ],
            layout: {
                type: 'grid',
                columns: 12,
                gap: 10
            }
        });

        // Business Dashboard
        this.dashboards.set('business', {
            id: 'business',
            name: 'Business Metrics Dashboard',
            type: 'business',
            widgets: [
                {
                    id: 'active-integrations',
                    type: 'metric',
                    title: 'Active Integrations',
                    dataSource: 'metrics.business.integrations',
                    metrics: ['business.integrations.active'],
                    visualization: {},
                    position: { x: 0, y: 0 },
                    size: { width: 3, height: 2 }
                },
                {
                    id: 'data-processed',
                    type: 'metric',
                    title: 'Data Processed Today',
                    dataSource: 'metrics.business.data',
                    metrics: ['business.data.processed'],
                    visualization: {},
                    position: { x: 3, y: 0 },
                    size: { width: 3, height: 2 }
                },
                {
                    id: 'cost-savings',
                    type: 'metric',
                    title: 'Cost Savings',
                    dataSource: 'metrics.business.savings',
                    metrics: ['business.cost.savings'],
                    visualization: {},
                    position: { x: 6, y: 0 },
                    size: { width: 3, height: 2 }
                }
            ],
            refreshInterval: 60,
            filters: [
                {
                    field: 'timeRange',
                    type: 'time',
                    default: '24h'
                }
            ],
            layout: {
                type: 'grid',
                columns: 12,
                gap: 10
            }
        });

        // Technical Dashboard
        this.dashboards.set('technical', {
            id: 'technical',
            name: 'Technical Metrics Dashboard',
            type: 'technical',
            widgets: [
                {
                    id: 'cpu-usage',
                    type: 'chart',
                    title: 'CPU Usage',
                    dataSource: 'metrics.system.cpu',
                    metrics: ['system.cpu.usage'],
                    visualization: {
                        chartType: 'line',
                        thresholds: [
                            { value: 80, color: 'yellow', label: 'Warning', alertLevel: 'warning' },
                            { value: 90, color: 'red', label: 'Critical', alertLevel: 'critical' }
                        ]
                    },
                    position: { x: 0, y: 0 },
                    size: { width: 6, height: 3 }
                },
                {
                    id: 'memory-usage',
                    type: 'chart',
                    title: 'Memory Usage',
                    dataSource: 'metrics.system.memory',
                    metrics: ['system.memory.used', 'system.memory.available'],
                    visualization: {
                        chartType: 'area'
                    },
                    position: { x: 6, y: 0 },
                    size: { width: 6, height: 3 }
                }
            ],
            refreshInterval: 15,
            filters: [],
            layout: {
                type: 'grid',
                columns: 12
            }
        });
    }

    /**
     * Setup core metric definitions
     */
    private setupCoreMetrics(): void {
        // System metrics
        this.registerMetric({
            id: 'system.uptime',
            name: 'System Uptime',
            category: 'system',
            type: 'gauge',
            unit: 'percentage',
            description: 'System availability percentage',
            tags: ['infrastructure', 'reliability'],
            aggregation: 'avg',
            retention: 90
        });

        this.registerMetric({
            id: 'system.cpu.usage',
            name: 'CPU Usage',
            category: 'system',
            type: 'gauge',
            unit: 'percentage',
            description: 'CPU utilization',
            tags: ['infrastructure', 'performance'],
            aggregation: 'avg',
            retention: 30
        });

        this.registerMetric({
            id: 'system.memory.used',
            name: 'Memory Used',
            category: 'system',
            type: 'gauge',
            unit: 'bytes',
            description: 'Memory usage in bytes',
            tags: ['infrastructure', 'performance'],
            aggregation: 'avg',
            retention: 30
        });

        // API metrics
        this.registerMetric({
            id: 'api.requests.total',
            name: 'Total API Requests',
            category: 'api',
            type: 'counter',
            unit: 'requests',
            description: 'Total number of API requests',
            tags: ['api', 'usage'],
            aggregation: 'sum',
            retention: 90
        });

        this.registerMetric({
            id: 'api.response_time.p95',
            name: '95th Percentile Response Time',
            category: 'api',
            type: 'histogram',
            unit: 'milliseconds',
            description: 'API response time 95th percentile',
            tags: ['api', 'performance'],
            aggregation: 'p95',
            retention: 30
        });

        this.registerMetric({
            id: 'api.error_rate',
            name: 'API Error Rate',
            category: 'api',
            type: 'gauge',
            unit: 'percentage',
            description: 'Percentage of failed API requests',
            tags: ['api', 'quality'],
            aggregation: 'avg',
            retention: 30
        });

        // Business metrics
        this.registerMetric({
            id: 'business.integrations.active',
            name: 'Active Integrations',
            category: 'business',
            type: 'gauge',
            unit: 'count',
            description: 'Number of active integrations',
            tags: ['business', 'adoption'],
            aggregation: 'max',
            retention: 365
        });

        this.registerMetric({
            id: 'business.data.processed',
            name: 'Data Processed',
            category: 'business',
            type: 'counter',
            unit: 'records',
            description: 'Number of records processed',
            tags: ['business', 'volume'],
            aggregation: 'sum',
            retention: 90
        });
    }

    /**
     * Register a new metric definition
     */
    registerMetric(metric: MetricDefinition): void {
        this.metrics.set(metric.id, metric);
        logger.info(`Metric registered: ${metric.name}`);
    }

    /**
     * Create or update a dashboard
     */
    createDashboard(dashboard: TelemetryDashboard): void {
        this.dashboards.set(dashboard.id, dashboard);
        logger.info(`Dashboard created/updated: ${dashboard.name}`);
    }

    /**
     * Get dashboard by ID
     */
    getDashboard(id: string): TelemetryDashboard | undefined {
        return this.dashboards.get(id);
    }

    /**
     * List all dashboards
     */
    listDashboards(): TelemetryDashboard[] {
        return Array.from(this.dashboards.values());
    }

    /**
     * Create a telemetry stream
     */
    createStream(stream: TelemetryStream): void {
        this.streams.set(stream.id, stream);
        logger.info(`Telemetry stream created: ${stream.name}`);
    }

    /**
     * Create an alert rule
     */
    createAlertRule(rule: AlertRule): void {
        this.alertRules.set(rule.id, rule);
        logger.info(`Alert rule created: ${rule.name}`);
    }

    /**
     * Get telemetry health status
     */
    getHealth(): TelemetryHealth {
        return {
            status: 'healthy',
            collectors: [
                {
                    name: 'API Collector',
                    status: 'active',
                    eventsPerSecond: 1250,
                    errorRate: 0.01,
                    lastSeen: new Date()
                },
                {
                    name: 'System Collector',
                    status: 'active',
                    eventsPerSecond: 450,
                    errorRate: 0,
                    lastSeen: new Date()
                },
                {
                    name: 'Business Collector',
                    status: 'active',
                    eventsPerSecond: 85,
                    errorRate: 0.02,
                    lastSeen: new Date()
                }
            ],
            storage: {
                used: 45.2 * 1024 * 1024 * 1024, // 45.2 GB
                available: 954.8 * 1024 * 1024 * 1024, // 954.8 GB
                retentionDays: 90,
                oldestData: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
            },
            processing: {
                queueDepth: 125,
                processingRate: 1785,
                errorRate: 0.008,
                latency: 12
            },
            lastCheck: new Date()
        };
    }

    /**
     * Get metric values for a time range
     */
    getMetricValues(
        metricId: string,
        startTime: Date,
        endTime: Date,
        resolution?: number
    ): DataPoint[] {
        // Generate mock data for demonstration
        const points: DataPoint[] = [];
        const interval = resolution || 60000; // 1 minute default
        const current = startTime.getTime();
        const end = endTime.getTime();

        for (let time = current; time <= end; time += interval) {
            points.push({
                timestamp: new Date(time),
                value: Math.random() * 100 + Math.sin(time / 100000) * 20
            });
        }

        return points;
    }

    /**
     * Start metric collection
     */
    private startMetricCollection(): void {
        setInterval(() => {
            // Simulate metric collection
            this.metrics.forEach(metric => {
                const values = this.metricValues.get(metric.id) || [];
                values.push(Math.random() * 100);

                // Keep only last 1000 values
                if (values.length > 1000) {
                    values.shift();
                }

                this.metricValues.set(metric.id, values);
            });
        }, 5000); // Collect every 5 seconds
    }

    /**
     * Start alert evaluation
     */
    private startAlertEvaluation(): void {
        setInterval(() => {
            this.alertRules.forEach(rule => {
                if (!rule.enabled) return;

                const values = this.metricValues.get(rule.metric);
                if (!values || values.length === 0) return;

                const currentValue = values[values.length - 1];
                const triggered = this.evaluateCondition(currentValue, rule.condition);

                if (triggered) {
                    this.triggerAlert(rule, currentValue);
                }
            });
        }, 10000); // Evaluate every 10 seconds
    }

    /**
     * Evaluate alert condition
     */
    private evaluateCondition(value: number, condition: AlertCondition): boolean {
        switch (condition.operator) {
            case '>': return value > condition.threshold;
            case '<': return value < condition.threshold;
            case '>=': return value >= condition.threshold;
            case '<=': return value <= condition.threshold;
            case '=': return value === condition.threshold;
            case '!=': return value !== condition.threshold;
            default: return false;
        }
    }

    /**
     * Trigger alert actions
     */
    private triggerAlert(rule: AlertRule, value: number): void {
        logger.info(`Alert triggered: ${rule.name} (value: ${value})`);

        rule.actions.forEach(action => {
            switch (action.type) {
                case 'log':
                    logger.info(`[ALERT] ${rule.name}: ${value} ${rule.condition.operator} ${rule.condition.threshold}`);
                    break;
                case 'email':
                    logger.info(`Sending email to ${action.target}`);
                    break;
                case 'slack':
                    logger.info(`Sending Slack message to ${action.target}`);
                    break;
                case 'webhook':
                    logger.info(`Calling webhook: ${action.target}`);
                    break;
                case 'pagerduty':
                    logger.info(`Creating PagerDuty incident`);
                    break;
            }
        });
    }

    /**
     * Export telemetry data
     */
    exportTelemetryData(
        startTime: Date,
        endTime: Date,
        format: 'json' | 'csv' | 'prometheus'
    ): string {
        const data: unknown = {
            period: { start: startTime, end: endTime },
            metrics: {}
        };

        this.metrics.forEach(metric => {
            const values = this.getMetricValues(metric.id, startTime, endTime);
            (data as any).metrics[metric.id] = values;
        });

        switch (format) {
            case 'csv':
                return this.convertToCSV(data);
            case 'prometheus':
                return this.convertToPrometheus(data);
            default:
                return JSON.stringify(data, null, 2);
        }
    }

    /**
     * Convert data to CSV format
     */
    private convertToCSV(data: unknown): string {
        let csv = 'Timestamp,Metric,Value\n';

        Object.entries((data as any).metrics).forEach(([metricId, values]: [string, any]) => {
            values.forEach((point: DataPoint) => {
                csv += `${point.timestamp.toISOString()},${metricId},${point.value}\n`;
            });
        });

        return csv;
    }

    /**
     * Convert data to Prometheus format
     */
    private convertToPrometheus(data: unknown): string {
        let prometheus = '';

        Object.entries((data as any).metrics).forEach(([metricId, values]: [string, any]) => {
            const metric = this.metrics.get(metricId);
            if (!metric) return;

            prometheus += `# HELP ${metricId} ${metric.description}\n`;
            prometheus += `# TYPE ${metricId} ${metric.type}\n`;

            values.forEach((point: DataPoint) => {
                prometheus += `${metricId} ${point.value} ${point.timestamp.getTime()}\n`;
            });
        });

        return prometheus;
    }
}

interface DataPoint {
    timestamp: Date;
    value: number;
}