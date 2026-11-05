import { QueryRejected } from '../../domain/errors';

export interface MetricDefinition {
  id: string;
  name: string;
  description: string;
  owner: string;
  grain: string;
  factTable: string;
  tables: string[];
  dateColumn: string;
  allowedDimensions: string[];
  allowedFilters: string[];
  synonyms: string[];
  fixedPredicates: string[];
}

export const METRICS: MetricDefinition[] = [
  {
    id: 'healing_rate_30d',
    name: '30-day healing rate',
    description:
      'Share of wounds with area reduced by at least 40 percent, or recorded closure, among wounds in the snapshot.',
    owner: 'wound-quality',
    grain: 'one row per wound on the snapshot date in curated_wound_outcomes',
    factTable: 'curated_wound_outcomes',
    tables: ['curated_wound_outcomes'],
    dateColumn: 'as_of_date',
    allowedDimensions: ['facility_id', 'wound_type', 'clinician_id'],
    allowedFilters: ['facility_id', 'wound_type', 'clinician_id'],
    synonyms: ['healing rate', 'closure rate', 'healed within 30 days'],
    fixedPredicates: [],
  },
  {
    id: 'overdue_dressing_changes',
    name: 'Overdue dressing changes',
    description: 'Open dressing-change tasks whose due date falls in the reporting window.',
    owner: 'tasking',
    grain: 'one row per care task in curated_care_tasks',
    factTable: 'curated_care_tasks',
    tables: ['curated_care_tasks'],
    dateColumn: 'due_date',
    allowedDimensions: ['facility_id', 'clinician_id'],
    allowedFilters: ['facility_id', 'clinician_id'],
    synonyms: ['overdue dressing', 'late dressing'],
    fixedPredicates: [`"task_type" = 'dressing-change'`, `"status" = 'open'`],
  },
  {
    id: 'clinician_caseload',
    name: 'Clinician caseload',
    description: 'Distinct open wounds per clinician on the snapshot.',
    owner: 'operations',
    grain: 'one row per wound on the snapshot date in curated_wound_outcomes',
    factTable: 'curated_wound_outcomes',
    tables: ['curated_wound_outcomes'],
    dateColumn: 'as_of_date',
    allowedDimensions: ['clinician_id', 'facility_id'],
    allowedFilters: ['clinician_id', 'facility_id'],
    synonyms: ['caseload', 'open wounds per clinician'],
    fixedPredicates: [`"status" = 'open'`],
  },
  {
    id: 'mean_area_change_14d',
    name: 'Mean area change',
    description: 'Mean area change ratio from the earliest assessment to the latest on or before the snapshot.',
    owner: 'wound-quality',
    grain: 'one row per wound on the snapshot date in curated_wound_outcomes',
    factTable: 'curated_wound_outcomes',
    tables: ['curated_wound_outcomes'],
    dateColumn: 'as_of_date',
    allowedDimensions: ['facility_id', 'wound_type'],
    allowedFilters: ['facility_id', 'wound_type'],
    synonyms: ['area change', 'wound area change'],
    fixedPredicates: [],
  },
  {
    id: 'visit_adherence',
    name: 'Visit adherence',
    description: 'Completed care tasks divided by all care tasks due in the window.',
    owner: 'operations',
    grain: 'one row per care task in curated_care_tasks',
    factTable: 'curated_care_tasks',
    tables: ['curated_care_tasks'],
    dateColumn: 'due_date',
    allowedDimensions: ['facility_id', 'clinician_id'],
    allowedFilters: ['facility_id', 'clinician_id'],
    synonyms: ['visit adherence', 'visit completion'],
    fixedPredicates: [],
  },
];

const MEASURES: Record<string, string> = {
  healing_rate_30d:
    'SUM(CASE WHEN healed_30d = 1 THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0) AS healing_rate',
  overdue_dressing_changes: 'COUNT(*) AS overdue_tasks',
  clinician_caseload: 'COUNT(DISTINCT "wound_id") AS open_wounds',
  mean_area_change_14d: 'AVG("area_change_ratio") AS mean_area_change',
  visit_adherence:
    `SUM(CASE WHEN "status" = 'completed' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0) AS visit_adherence`,
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
const FILTER_VALUE = /^[a-z0-9_-]+$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;

export function quoteIdent(name: string, allowed?: readonly string[]): string {
  if (!IDENT.test(name) || (allowed && !allowed.includes(name))) {
    throw new QueryRejected(`identifier is not allowed: ${name}`);
  }
  return `"${name}"`;
}

export interface RenderInput {
  metric: MetricDefinition;
  dimensions: string[];
  filters: Record<string, string[]>;
  timeRange: { start: string; end: string };
  tenantId: string;
  facilityScope?: string[];
  limit: number;
}

export interface BuiltQuery {
  metric: string;
  sql: string;
  params: Array<string | number>;
  tables: string[];
}

export function renderMetric(input: RenderInput): BuiltQuery {
  const metric = input.metric;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new QueryRejected('limit must be an integer from 1 to 500');
  }
  if (!DATE_VALUE.test(input.timeRange.start) || !DATE_VALUE.test(input.timeRange.end)) {
    throw new QueryRejected('time range dates must be YYYY-MM-DD');
  }
  for (const dimension of input.dimensions) {
    if (!metric.allowedDimensions.includes(dimension)) {
      throw new QueryRejected(`dimension is not allowed: ${dimension}`);
    }
  }
  const selectDims = input.dimensions.map((dimension) => quoteIdent(dimension, metric.allowedDimensions));
  const measure = MEASURES[metric.id];
  if (!measure) throw new QueryRejected(`metric has no template: ${metric.id}`);
  const select = selectDims.length > 0 ? `${selectDims.join(', ')}, ${measure}` : measure;
  const group = selectDims.length > 0 ? ` GROUP BY ${selectDims.join(', ')}` : '';
  const { where, params } = whereClause(input);
  const sql = `SELECT ${select} FROM ${quoteIdent(metric.factTable)} WHERE ${where}${group} LIMIT ${input.limit}`;
  return { metric: metric.id, sql, params, tables: [...metric.tables] };
}

function whereClause(input: RenderInput): { where: string; params: Array<string | number> } {
  const metric = input.metric;
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [input.tenantId];
  clauses.push(`${quoteIdent(metric.dateColumn)} >= ?`);
  clauses.push(`${quoteIdent(metric.dateColumn)} < ?`);
  params.push(input.timeRange.start, input.timeRange.end);
  if (input.facilityScope) {
    if (input.facilityScope.length === 0) {
      throw new QueryRejected('caller has no facility scope');
    }
    for (const facilityId of input.facilityScope) assertFilterValue(facilityId);
    clauses.push(`"facility_id" IN (${input.facilityScope.map(() => '?').join(', ')})`);
    params.push(...input.facilityScope);
  }
  for (const predicate of metric.fixedPredicates) clauses.push(predicate);
  for (const [key, values] of Object.entries(input.filters)) {
    if (!metric.allowedFilters.includes(key)) throw new QueryRejected(`filter is not allowed: ${key}`);
    if (values.length === 0) throw new QueryRejected(`filter ${key} needs a value`);
    for (const value of values) assertFilterValue(value);
    clauses.push(`${quoteIdent(key, metric.allowedFilters)} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
  return { where: clauses.join(' AND '), params };
}

function assertFilterValue(value: string): void {
  if (!FILTER_VALUE.test(value)) throw new QueryRejected('filter value is not allowed');
}

export function assertSafeSql(query: BuiltQuery, metric: MetricDefinition): void {
  const sql = query.sql;
  if (sql.includes(';') || sql.includes('--') || sql.includes('/*')) {
    throw new QueryRejected('query contains a forbidden token');
  }
  if (!sql.includes('tenant_id = ?')) throw new QueryRejected('tenant predicate missing');
  if (!/\bLIMIT\s+\d+\s*$/.test(sql)) throw new QueryRejected('row limit missing');
  if (query.params[0] !== undefined && typeof query.params[0] !== 'string') {
    throw new QueryRejected('tenant parameter missing');
  }
  const tables = [...sql.matchAll(/\bFROM\s+"([a-z0-9_]+)"/gi)].map((match) => match[1]);
  if (tables.length === 0) throw new QueryRejected('query has no table');
  for (const table of tables) {
    if (!metric.tables.includes(table)) throw new QueryRejected(`table is not allowed: ${table}`);
  }
}

export function findMetric(id: string): MetricDefinition | undefined {
  return METRICS.find((metric) => metric.id === id);
}

export function resolveMetric(request: { metric?: string; search?: string }): MetricDefinition {
  if (request.metric) {
    const found = findMetric(request.metric);
    if (!found) throw new QueryRejected(`unknown metric: ${request.metric}`);
    return found;
  }
  const search = request.search?.trim().toLowerCase();
  if (!search) throw new QueryRejected('metric or search is required');
  const hits = METRICS.filter((metric) => metric.synonyms.some((synonym) => search.includes(synonym)));
  if (hits.length === 0) throw new QueryRejected('no metric matches the search text');
  if (hits.length > 1) {
    throw new QueryRejected(`search matches multiple metrics: ${hits.map((hit) => hit.id).join(', ')}`);
  }
  return hits[0];
}
