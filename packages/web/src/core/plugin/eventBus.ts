import { hostLogger } from './logger';

/**
 * Événements inter-plugins partagés.
 * Ajouter ici les événements transverses au moment où deux plugins en ont besoin
 * (ex. 'network:selected' → { endpointId, network }).
 */
export interface PluginEvents {
  // volontairement vide pour l'instant
}

type Handler<T> = (payload: T) => void;

export interface EventBus {
  /** S'abonner ; renvoie la fonction de désabonnement. */
  on<K extends keyof PluginEvents>(event: K, handler: Handler<PluginEvents[K]>): () => void;
  /** Émettre ; un handler en échec est loggé sans bloquer les autres. */
  emit<K extends keyof PluginEvents>(event: K, payload: PluginEvents[K]): void;
}

function createEventBus(): EventBus {
  const handlers = new Map<string, Set<Handler<never>>>();
  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as Handler<never>);
      return () => {
        set?.delete(handler as Handler<never>);
      };
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set || set.size === 0) return;
      for (const h of [...set]) {
        try {
          (h as Handler<unknown>)(payload);
        } catch (err) {
          hostLogger.error(`handler « ${String(event)} » en échec`, err);
        }
      }
    },
  };
}

/** Bus unique du host, partagé par tous les plugins via PluginContext. */
export const eventBus: EventBus = createEventBus();
