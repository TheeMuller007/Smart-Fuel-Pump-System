/**
 * Minimal in-process pub/sub used to broadcast pump/dispense events to
 * Server-Sent-Events subscribers (stage 10). Events are not persisted;
 * clients re-sync via the REST endpoints on (re)connect.
 */

const subscribers = new Set();

function subscribe(res, filters = {}) {
  const sub = {
    res,
    pumpId: filters.pumpId || null,
    stationId: filters.stationId || null,
    userId: filters.userId || null,
  };
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

function formatSse(event) {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Publish an event to every matching subscriber.
 * targets: [{ type: 'pump', id }, { type: 'station', id }, { type: 'user', id }, ...]
 * A subscriber receives the event when any target matches its filter.
 */
function publish(event, data, targets = []) {
  const payload = formatSse({ event, data, at: new Date().toISOString() });
  for (const sub of subscribers) {
    const matches = targets.some((t) => {
      if (t.type === 'pump') return sub.pumpId && sub.pumpId === t.id;
      if (t.type === 'station') return sub.stationId && sub.stationId === t.id;
      if (t.type === 'user') return sub.userId && sub.userId === t.id;
      return false;
    });
    if (!matches) continue;
    try {
      sub.res.write(payload);
    } catch {
      subscribers.delete(sub);
    }
  }
}

function subscriberCount() {
  return subscribers.size;
}

module.exports = { subscribe, publish, subscriberCount };
