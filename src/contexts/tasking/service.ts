import { randomUUID } from 'crypto';
import { InProcessEventBus } from '../../domain/event-bus';
import { DomainError } from '../../domain/errors';
import { CareTask, completeTask } from './model';

export interface TaskRepository {
  save(task: CareTask): void;
  get(tenantId: string, id: string): CareTask | undefined;
  list(tenantId: string): CareTask[];
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, CareTask>();

  save(task: CareTask): void {
    this.tasks.set(`${task.tenantId}/${task.id}`, { ...task });
  }

  get(tenantId: string, id: string): CareTask | undefined {
    const found = this.tasks.get(`${tenantId}/${id}`);
    return found ? { ...found } : undefined;
  }

  list(tenantId: string): CareTask[] {
    return [...this.tasks.values()].filter((task) => task.tenantId === tenantId).map((task) => ({ ...task }));
  }
}

export class TaskingService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly bus: InProcessEventBus,
    private readonly ids: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  schedule(task: CareTask): void {
    if (this.repository.get(task.tenantId, task.id)) {
      throw new DomainError(`task ${task.id} already exists`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) {
      throw new DomainError('dueDate must be YYYY-MM-DD');
    }
    this.repository.save({ ...task, status: 'open', completedAt: undefined });
  }

  async complete(tenantId: string, taskId: string, completedAt: string): Promise<CareTask> {
    const current = this.repository.get(tenantId, taskId);
    if (!current) throw new DomainError('task not found', 'not_found', 404);
    const { task, events } = completeTask(current, completedAt, { eventId: this.ids, now: this.now });
    this.repository.save(task);
    await this.bus.publish(events);
    return task;
  }
}
