import { QueryRejected } from '../../domain/errors';
import { PatientCareRepository } from '../patient-care/repository';
import { TaskRepository } from '../tasking/service';
import { assertSafeSql, BuiltQuery, METRICS, MetricDefinition, renderMetric, resolveMetric } from './metrics';
import { OutcomeRow, projectOutcomes, projectTasks, TaskRow } from './projection';
import { SemanticGraph } from './semantic-graph';

export interface AnalyticsEngine {
  readonly name: 'sqlite' | 'athena';
  query(sql: string, params: Array<string | number>): Promise<Record<string, unknown>[]>;
  replace?(outcomes: OutcomeRow[], tasks: TaskRow[]): Promise<void>;
}

export interface AnalyticsQueryRequest {
  metric?: string;
  search?: string;
  dimensions?: string[];
  filters?: Record<string, string | string[]>;
  timeRange?: { start: string; end: string };
}

export interface AnalyticsAccess {
  tenantId: string;
  facilityIds?: string[];
}

export class AnalyticsService {
  readonly graph: SemanticGraph;

  constructor(
    private readonly engine: AnalyticsEngine,
    private readonly patients: PatientCareRepository,
    private readonly tasks: TaskRepository,
    private readonly tenantId: string,
    private readonly snapshotDate: string,
    private readonly defaultTimeRange: { start: string; end: string },
  ) {
    this.graph = SemanticGraph.fromMetrics(METRICS);
  }

  listMetrics(): Pick<MetricDefinition, 'id' | 'name' | 'description' | 'owner' | 'grain' | 'factTable' | 'allowedDimensions' | 'allowedFilters' | 'synonyms'>[] {
    return METRICS.map((metric) => ({
      id: metric.id,
      name: metric.name,
      description: metric.description,
      owner: metric.owner,
      grain: metric.grain,
      factTable: metric.factTable,
      allowedDimensions: metric.allowedDimensions,
      allowedFilters: metric.allowedFilters,
      synonyms: metric.synonyms,
    }));
  }

  async refresh(): Promise<void> {
    if (!this.engine.replace) return;
    await this.engine.replace(
      projectOutcomes(this.patients.listWounds(this.tenantId).map((wound) => wound.snapshot), this.snapshotDate),
      projectTasks(this.tasks.list(this.tenantId), this.snapshotDate),
    );
  }

  async query(access: AnalyticsAccess, request: AnalyticsQueryRequest): Promise<{
    metric: string;
    description: string;
    grain: string;
    timeRange: { start: string; end: string };
    dimensions: string[];
    sql: string;
    params: Array<string | number>;
    rows: Record<string, unknown>[];
    engine: string;
  }> {
    const metric = resolveMetric(request);
    if (this.graph.factTable(metric.id) !== metric.factTable) {
      throw new QueryRejected('semantic graph does not match the metric catalog');
    }
    const dimensions = request.dimensions ?? [];
    for (const dimension of dimensions) {
      if (!this.graph.allowedDimensions(metric.id).includes(dimension)) {
        throw new QueryRejected(`dimension is not on the semantic graph: ${dimension}`);
      }
    }
    const filters: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(request.filters ?? {})) {
      const values = (Array.isArray(value) ? value : [value]).map(String);
      if (key === 'facility_id' && access.facilityIds) {
        for (const facilityId of values) {
          if (!access.facilityIds.includes(facilityId)) {
            throw new QueryRejected('facility filter is outside the caller scope');
          }
        }
      }
      filters[key] = values;
    }
    const timeRange = request.timeRange ?? this.defaultTimeRange;
    const built: BuiltQuery = renderMetric({
      metric,
      dimensions,
      filters,
      timeRange,
      tenantId: access.tenantId,
      facilityScope: access.facilityIds,
      limit: 500,
    });
    assertSafeSql(built, metric);
    const rows = await this.engine.query(built.sql, built.params);
    return {
      metric: metric.id,
      description: metric.description,
      grain: metric.grain,
      timeRange,
      dimensions,
      sql: built.sql,
      params: built.params,
      rows,
      engine: this.engine.name,
    };
  }
}
