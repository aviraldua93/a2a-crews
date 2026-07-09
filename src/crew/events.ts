type EventType =
  | 'crew:started'
  | 'crew:completed'
  | 'crew:failed'
  | 'wave:started'
  | 'wave:completed'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'agent:spawned'
  | 'agent:died'
  | 'agent:retried'
  | 'goal:started'
  | 'goal:checkpoint'
  | 'goal:paused'
  | 'goal:resumed'
  | 'goal:completed'
  | 'goal:cleared';

interface CrewEvent {
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type EventHandler = (event: CrewEvent) => void;

class EventBus {
  private handlers: Map<EventType, EventHandler[]> = new Map();

  on(type: EventType, handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  emit(type: EventType, data: Record<string, unknown> = {}): void {
    const event: CrewEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    const handlers = this.handlers.get(type) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
  }
}

export const eventBus = new EventBus();
export type { EventType, CrewEvent, EventHandler };
