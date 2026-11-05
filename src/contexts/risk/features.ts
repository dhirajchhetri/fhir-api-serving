import { Assessment, WoundState } from '../patient-care/model';
import { CareTask } from '../tasking/model';

export interface RiskFeatures {
  woundType: string;
  areaChangeRatio: number;
  comorbidityCount: number;
  visitAdherence: number;
  baselineAreaCm2: number;
  depthCm: number;
  tissueType: string;
  offloading: boolean;
}

export function extractFeatures(wound: WoundState, comorbidityCount: number, tasks: CareTask[]): RiskFeatures {
  const assessments = wound.assessments;
  const earliest = assessments[0];
  const latest = assessments[assessments.length - 1];
  const baseline = earliest ? area(earliest) : 0;
  const latestArea = latest ? area(latest) : 0;
  const ratio = baseline === 0 ? 0 : (latestArea - baseline) / baseline;
  const related = tasks.filter((task) => task.woundId === wound.id);
  const adherence = related.length === 0 ? 1 : related.filter((task) => task.status === 'completed').length / related.length;
  return {
    woundType: wound.woundType,
    areaChangeRatio: ratio,
    comorbidityCount,
    visitAdherence: adherence,
    baselineAreaCm2: baseline,
    depthCm: latest ? depth(latest) : 0,
    tissueType: latest?.tissueType ?? 'granulation',
    offloading: latest?.offloading ?? false,
  };
}

function area(assessment: Assessment): number {
  return assessment.measurements.find((measurement) => measurement.code === 'area-cm2')?.value ?? 0;
}

function depth(assessment: Assessment): number {
  return assessment.measurements.find((measurement) => measurement.code === 'depth-cm')?.value ?? 0;
}
