import * as vscode from "vscode";
import { randomUUID } from "crypto";

export type QueueStatus = "queued" | "running" | "completed" | "failed";
export interface QueueEvent { id: string; label: string; status: QueueStatus; error?: string; }

interface QueueEntry<T> {
  id: string;
  label: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** A single extension-host queue shared by chat entry points. */
export class TaskQueue implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<QueueEvent>();
  readonly onDidChange = this.emitter.event;
  private readonly waiting: QueueEntry<unknown>[] = [];
  private active = 0;
  private disposed = false;

  private concurrency: number;

  constructor(concurrency = 2, private readonly persist?: (event: QueueEvent) => void) {
    this.concurrency = this.normalizeConcurrency(concurrency);
  }

  setConcurrency(concurrency: number) {
    this.concurrency = this.normalizeConcurrency(concurrency);
    this.pump();
  }

  enqueue<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Task queue is shut down."));
    const id = randomUUID();
    this.publish({ id, label, status: "queued" });
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ id, label, run, resolve, reject } as QueueEntry<unknown>);
      this.pump();
    });
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.waiting.splice(0)) entry.reject(new Error("Task queue is shutting down."));
    this.emitter.dispose();
  }

  private pump() {
    while (!this.disposed && this.active < this.concurrency && this.waiting.length) {
      const entry = this.waiting.shift()!;
      this.active++;
        this.publish({ id: entry.id, label: entry.label, status: "running" });
      void entry.run().then(value => {
        this.publish({ id: entry.id, label: entry.label, status: "completed" });
        entry.resolve(value);
      }, error => {
        this.publish({ id: entry.id, label: entry.label, status: "failed", error: error instanceof Error ? error.message : String(error) });
        entry.reject(error);
      }).finally(() => { this.active--; this.pump(); });
    }
  }

  private publish(event: QueueEvent) {
    this.persist?.(event);
    this.emitter.fire(event);
  }

  private normalizeConcurrency(value: number) {
    return Number.isFinite(value) ? Math.max(1, Math.min(16, Math.floor(value))) : 2;
  }
}
