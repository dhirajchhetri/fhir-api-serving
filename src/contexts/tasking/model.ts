import { randomUUID } from 'crypto';
import { DomainError } from '../../domain/errors';
import { CareTaskCompletedPayload, domainEvent, DomainEvent } from '../../domain/events';

export type TaskType = 'dressing-change' | 'visit';
export type TaskStatus = 'open' | 'completed';

export interface CareTask {
  id: string;
  tenantId: string;
  facilityId: string;
  patientId: string;
  woundId: string;
  clinicianId: string;
  taskType: TaskType;
  status: TaskStatus;
  dueDate: string;
  completedAt?: string;
}

export function completeTask(
  task: CareTask,
  completedAt: string,
  ids: { eventId: () => string; now: () => string } = { eventId: randomUUID, now: () => new Date().toISOString() },
): { task: CareTask; events: DomainEvent[] } {
  if (task.status === 'completed') {
    throw new DomainError('task is already completed');
  }
  const next: CareTask = { ...task, status: 'completed', completedAt };
  const payload: CareTaskCompletedPayload = {
    patientId: task.patientId,
    facilityId: task.facilityId,
    woundId: task.woundId,
    taskType: task.taskType,
    completedAt,
  };
  const events = [
    domainEvent('CareTaskCompleted', {
      id: ids.eventId(),
      occurredAt: ids.now(),
      tenantId: task.tenantId,
      aggregateId: task.id,
      payload,
    }),
  ];
  return { task: next, events };
}
