export interface Logger {
  debug(msg: string, ...meta: unknown[]): void;
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
}

function make(prefix: string): Logger {
  const p = `[plugin:${prefix}]`;
  return {
    debug: (m, ...meta) => console.debug(p, m, ...meta),
    info: (m, ...meta) => console.info(p, m, ...meta),
    warn: (m, ...meta) => console.warn(p, m, ...meta),
    error: (m, ...meta) => console.error(p, m, ...meta),
  };
}

/** Logger du host (loader, registry…). */
export const hostLogger: Logger = make('host');

/** Logger dédié à un plugin (prefixe = id du plugin). */
export function pluginLogger(id: string): Logger {
  return make(id);
}
