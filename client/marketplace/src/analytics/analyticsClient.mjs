import { validateAnalyticsEvent } from './schema.mjs';

export class AnalyticsClient {
  constructor({ sink = null, now = () => new Date().toISOString() } = {}) {
    this.sink = typeof sink === 'function' ? sink : null;
    this.now = now;
    this.queue = [];
  }

  track(eventName, payload = {}, context = {}) {
    const validation = validateAnalyticsEvent(eventName, payload);
    if (!validation.ok) {
      throw new Error(`analytics schema guard failed: ${validation.error}`);
    }

    const event = {
      event_name: eventName,
      payload,
      context,
      occurred_at: this.now()
    };

    this.queue.push(event);
    if (this.sink) this.sink(event);
    return event;
  }

  snapshot() {
    return this.queue.slice();
  }

  reset() {
    this.queue.length = 0;
  }
}
