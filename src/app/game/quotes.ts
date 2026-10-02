import { Injectable, OnDestroy, signal } from '@angular/core';

const QUOTES_URL = 'quotes.json';
const ROTATE_MS = 30_000;

export interface Quote {
  readonly id: number;
  readonly chapter: number;
  readonly quote: string;
}

/**
 * Serves one quote at a time, swapping every 30s. The signal holds an array of
 * 0 or 1 entries so templates can `@for ... track id` and get a fresh element
 * (and therefore a replayed fade-in) on every swap.
 */
@Injectable({ providedIn: 'root' })
export class Quotes implements OnDestroy {
  readonly current = signal<readonly Quote[]>([]);

  private all: readonly Quote[] = [];
  private index = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    void this.load();
  }

  ngOnDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch(QUOTES_URL);
      if (!response.ok) return;
      const quotes = (await response.json()) as Quote[];
      if (!Array.isArray(quotes) || quotes.length === 0) return;
      this.all = quotes;
      this.index = Math.floor(Math.random() * quotes.length);
      this.show();
      this.timer = setInterval(() => {
        this.index = (this.index + 1) % this.all.length;
        this.show();
      }, ROTATE_MS);
    } catch {
      // Quotes are decorative: a failed fetch just leaves the slot empty.
    }
  }

  private show(): void {
    this.current.set([this.all[this.index]]);
  }
}
