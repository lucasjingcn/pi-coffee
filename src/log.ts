/**
 * Diagnostic logging shared by the daemon, its state store and the stdio proxy.
 *
 * Every line goes to stderr — the destination the supervisor already points at
 * (`~/.pi-coffee/logs/daemon.err.log` under launchd/systemd, the container's
 * stderr, or the terminal in foreground mode) — with an ISO-8601 timestamp so
 * the log can be read without guessing when something happened.
 *
 * Tags stay stable (`pi-coffee`, `state`, `pi-coffee-proxy`) so existing greps
 * keep working; only the timestamp prefix is new.
 */
export function logLine(tag: string, ...args: unknown[]): void {
  console.error(`[${new Date().toISOString()}] [${tag}]`, ...args);
}
