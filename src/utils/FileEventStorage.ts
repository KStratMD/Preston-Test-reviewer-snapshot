import fs from "fs";
import path from "path";
import type { DomainEvent, EventMetadata } from "./EventBus";

type SerializedDomainEvent = Omit<DomainEvent, "metadata"> & {
  metadata: Omit<EventMetadata, "timestamp"> & { timestamp: string };
};

export class FileEventStorage {
  private readonly overflowPath: string;
  private readonly deadLetterPath: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.overflowPath = path.join(dir, "overflow-events.json");
    this.deadLetterPath = path.join(dir, "dead-letter-events.json");
  }

  private load(file: string): DomainEvent[] {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as SerializedDomainEvent[];
    return raw.map(e => ({
      ...e,
      metadata: { ...e.metadata, timestamp: new Date(e.metadata.timestamp) },
    }));
  }

  private save(file: string, events: DomainEvent[]): void {
    fs.writeFileSync(file, JSON.stringify(events, null, 2));
  }

  persistOverflowEvent(event: DomainEvent): void {
    const events = this.load(this.overflowPath);
    events.push(event);
    this.save(this.overflowPath, events);
  }

  loadOverflowEvents(): DomainEvent[] {
    const events = this.load(this.overflowPath);
    if (fs.existsSync(this.overflowPath)) {
      fs.unlinkSync(this.overflowPath);
    }
    return events;
  }

  persistDeadLetterEvent(event: DomainEvent): void {
    const events = this.load(this.deadLetterPath);
    events.push(event);
    this.save(this.deadLetterPath, events);
  }

  loadDeadLetterEvents(): DomainEvent[] {
    const events = this.load(this.deadLetterPath);
    if (fs.existsSync(this.deadLetterPath)) {
      fs.unlinkSync(this.deadLetterPath);
    }
    return events;
  }
}
