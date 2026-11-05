import { DomainEvent } from './events';

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

/**
 * In-process stand-in for EventBridge. Handlers run in subscription order.
 * A handler may publish further events; those run before publish() returns.
 */
export class InProcessEventBus {
  private readonly handlers: EventHandler[] = [];

  subscribe(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of [...this.handlers]) {
        await handler(event);
      }
    }
  }
}
