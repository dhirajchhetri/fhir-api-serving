import { assertSafeSql, findMetric, renderMetric, resolveMetric } from '../src/contexts/analytics/metrics';
import { SemanticGraph, toOpenCypher } from '../src/contexts/analytics/semantic-graph';
import { METRICS } from '../src/contexts/analytics/metrics';
import { projectOutcomes, projectTasks } from '../src/contexts/analytics/projection';
import { bind } from '../src/contexts/analytics/athena-engine';
import { QueryRejected } from '../src/domain/errors';
import { Wound } from '../src/contexts/patient-care/model';
import { WOUNDS } from '../src/seed/cohort';

describe('query builder', () => {
  const metric = findMetric('healing_rate_30d');
  if (!metric) throw new Error('metric missing');

  it('renders a reviewed template with a tenant predicate and bound filters', () => {
    const built = renderMetric({
      metric,
      dimensions: ['facility_id'],
      filters: { wound_type: ['pressure-injury'] },
      timeRange: { start: '2026-09-01', end: '2026-11-01' },
      tenantId: 'tenant-demo',
      facilityScope: ['fac-harbor'],
      limit: 500,
    });
    expect(built.sql).toBe(
      'SELECT "facility_id", SUM(CASE WHEN healed_30d = 1 THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0) AS healing_rate FROM "curated_wound_outcomes" WHERE tenant_id = ? AND "as_of_date" >= ? AND "as_of_date" < ? AND "facility_id" IN (?) AND "wound_type" IN (?) GROUP BY "facility_id" LIMIT 500',
    );
    expect(built.params).toEqual(['tenant-demo', '2026-09-01', '2026-11-01', 'fac-harbor', 'pressure-injury']);
    expect(() => assertSafeSql(built, metric)).not.toThrow();
  });

  it('rejects identifiers and values that are not on the allow list', () => {
    expect(() => renderMetric({
      metric,
      dimensions: ['facility_id; drop'],
      filters: {},
      timeRange: { start: '2026-09-01', end: '2026-11-01' },
      tenantId: 'tenant-demo',
      limit: 500,
    })).toThrow(QueryRejected);
    expect(() => renderMetric({
      metric,
      dimensions: [],
      filters: { wound_type: ['pressure-injury; drop table'] },
      timeRange: { start: '2026-09-01', end: '2026-11-01' },
      tenantId: 'tenant-demo',
      limit: 500,
    })).toThrow(QueryRejected);
  });

  it('resolves a synonym and refuses an ambiguous search', () => {
    expect(resolveMetric({ search: 'show the healing rate by site' }).id).toBe('healing_rate_30d');
    expect(resolveMetric({ search: 'overdue dressing changes' }).id).toBe('overdue_dressing_changes');
    expect(() => resolveMetric({ search: 'healing rate and caseload' })).toThrow(/multiple metrics/);
    expect(() => resolveMetric({ search: 'drop table outcomes' })).toThrow(/no metric/);
  });
});

describe('semantic graph', () => {
  const graph = SemanticGraph.fromMetrics(METRICS);

  it('links every metric to its fact table', () => {
    for (const metric of METRICS) {
      expect(graph.factTable(metric.id)).toBe(metric.factTable);
      expect(graph.allowedDimensions(metric.id).sort()).toEqual([...metric.allowedDimensions].sort());
    }
    const cypher = toOpenCypher(graph);
    expect(cypher).toContain('[:READS]');
    expect(cypher).toContain('healing_rate_30d');
  });
});

describe('curated projection', () => {
  it('flags a 50 percent area reduction as healed and a small change as not', () => {
    const reduced = withAreas(WOUNDS[0], [12, 6]);
    const stalled = withAreas(WOUNDS[1], [8, 7.6]);
    const rows = projectOutcomes([reduced, stalled], '2026-10-15');
    expect(rows[0].healed_30d).toBe(1);
    expect(rows[0].area_change_ratio).toBeCloseTo(-0.5);
    expect(rows[1].healed_30d).toBe(0);
    expect(projectTasks([{
      id: 'task-02',
      tenantId: 'tenant-demo',
      facilityId: 'fac-harbor',
      patientId: 'pat-1002',
      woundId: 'wound-1002',
      clinicianId: 'clin-01',
      taskType: 'dressing-change',
      status: 'open',
      dueDate: '2026-10-01',
    }], '2026-10-15')[0].status).toBe('open');
  });
});

describe('athena literal binding', () => {
  it('escapes string parameters and leaves numbers bare', () => {
    expect(bind('SELECT x FROM t WHERE tenant_id = ? AND n = ?', ["o'hare", 2])).toBe(
      "SELECT x FROM t WHERE tenant_id = 'o''hare' AND n = 2",
    );
  });
});

function withAreas(input: (typeof WOUNDS)[number], areas: number[]) {
  let wound = Wound.open(input);
  areas.forEach((area, index) => {
    wound = wound.recordAssessment({
      assessedAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      clinicianId: input.clinicianId,
      tissueType: 'granulation',
      offloading: true,
      closed: false,
      measurements: [{ code: 'area-cm2', value: area, unit: 'cm2' }],
    }).wound;
  });
  return wound.snapshot;
}
