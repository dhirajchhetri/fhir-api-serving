import { MetricDefinition } from './metrics';

export interface GraphNode {
  id: string;
  label: 'Metric' | 'Table' | 'Dimension' | 'Filter';
  properties: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'READS' | 'ALLOWS_DIMENSION' | 'ALLOWS_FILTER';
}

/** In-memory semantic graph. The same shape is loaded into Neptune in the deployed stack. */
export class SemanticGraph {
  constructor(
    readonly nodes: GraphNode[],
    readonly edges: GraphEdge[],
  ) {}

  static fromMetrics(metrics: MetricDefinition[]): SemanticGraph {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const add = (node: GraphNode) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      nodes.push(node);
    };
    for (const metric of metrics) {
      const metricId = `metric:${metric.id}`;
      add({
        id: metricId,
        label: 'Metric',
        properties: { id: metric.id, owner: metric.owner, grain: metric.grain, factTable: metric.factTable },
      });
      const tableId = `table:${metric.factTable}`;
      add({ id: tableId, label: 'Table', properties: { name: metric.factTable } });
      edges.push({ from: metricId, to: tableId, type: 'READS' });
      for (const dimension of metric.allowedDimensions) {
        const dimensionId = `dimension:${dimension}`;
        add({ id: dimensionId, label: 'Dimension', properties: { name: dimension } });
        edges.push({ from: metricId, to: dimensionId, type: 'ALLOWS_DIMENSION' });
      }
      for (const filter of metric.allowedFilters) {
        const filterId = `filter:${filter}`;
        add({ id: filterId, label: 'Filter', properties: { name: filter } });
        edges.push({ from: metricId, to: filterId, type: 'ALLOWS_FILTER' });
      }
    }
    return new SemanticGraph(nodes, edges);
  }

  factTable(metricId: string): string | undefined {
    const edge = this.edges.find((item) => item.from === `metric:${metricId}` && item.type === 'READS');
    if (!edge) return undefined;
    return this.nodes.find((node) => node.id === edge.to)?.properties.name;
  }

  allowedDimensions(metricId: string): string[] {
    return this.edges
      .filter((edge) => edge.from === `metric:${metricId}` && edge.type === 'ALLOWS_DIMENSION')
      .map((edge) => this.nodes.find((node) => node.id === edge.to)?.properties.name)
      .filter((name): name is string => Boolean(name));
  }
}

export function toOpenCypher(graph: SemanticGraph): string {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    const props = Object.entries(node.properties)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ');
    lines.push(`MERGE (:${node.label} {${props}});`);
  }
  for (const edge of graph.edges) {
    const from = graph.nodes.find((node) => node.id === edge.from);
    const to = graph.nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    const fromKey = from.label === 'Metric' ? 'id' : 'name';
    const toKey = to.label === 'Metric' ? 'id' : 'name';
    lines.push(
      `MATCH (a:${from.label} {${fromKey}: ${JSON.stringify(from.properties[fromKey])}}), (b:${to.label} {${toKey}: ${JSON.stringify(to.properties[toKey])}}) MERGE (a)-[:${edge.type}]->(b);`,
    );
  }
  return lines.join('\n');
}
