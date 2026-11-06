import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { z } from 'zod';
import { PLUGIN_ID_RE } from '@prox4u/shared';
import * as apiClient from '../api/apiClient';
import type { EventBus } from './eventBus';
import type { Logger } from './logger';

/** Client API REST partagé (backend Fastify : /api/* + WS). */
export type ApiClient = typeof apiClient;

/** Route injectée dans le <Routes> du host. */
export interface PluginRoute {
  path: string;
  element: ComponentType;
}

/** Entrée de menu rendue par PluginMenu (tri par `order`, défaut 100). */
export interface PluginMenuItem {
  id: string;
  to: string;
  /** Clé i18n du libellé (ex. 'nav.topology'). */
  labelKey: string;
  icon?: LucideIcon;
  order?: number;
  /**
   * Sous-menu repliable rendu sous l'entrée (chevron dédié, état persisté
   * `navTreeExpanded`) — ex. l'arbre endpoints/nœuds Proxmox sous « Vue d'ensemble ».
   */
  submenu?: ReactNode;
  /** Pastille de statut agrégée (composant : peut s'abonner aux stores) — rendue à gauche de l'icône. */
  statusDot?: ComponentType;
}

export interface PluginManifest {
  /**
   * Identifiant stable : famille ('hypervision') ou version dérivée
   * '<famille>_vN' (ex. 'vm-view_v2'). Toute modification d'un module
   * crée une nouvelle version — on ne modifie jamais une version en place.
   */
  id: string;
  name: string;
  version: string;
  routes?: PluginRoute[];
  menu?: PluginMenuItem[];
  /** ids d'autres plugins requis (doivent être actifs). */
  dependencies?: string[];
}

/** Contexte injecté dans init() : services partagés du host. */
export interface PluginContext {
  api: ApiClient;
  eventBus: EventBus;
  logger: Logger;
}

export interface Plugin {
  manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void> | void;
  /** Cleanup (désabonnement eventBus, timers…) — appelé par disposePlugins(). */
  dispose?(): void | Promise<void>;
  /** Rendu principal si le plugin est monté via un PluginSlot. */
  Component?: ComponentType;
}

/* ------------------------------------------------------------------ */
/* Validation runtime des manifests (zod)                              */
/* ------------------------------------------------------------------ */

/** Composant React (fonction ou classe) — check minimal, le reste est typé. */
const componentSchema = z.custom<ComponentType>(
  (v) => typeof v === 'function' || (typeof v === 'object' && v !== null),
  { message: 'doit être un composant React' },
);

const iconSchema = z.custom<LucideIcon | undefined>(
  (v) => v === undefined || typeof v === 'function' || (typeof v === 'object' && v !== null),
  { message: 'doit être une icône Lucide' },
);

/** Node React (élément, chaîne, nombre…) — le sous-menu d'une entrée de menu. */
const reactNodeSchema = z.custom<ReactNode | undefined>(
  (v) =>
    v === undefined ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    (typeof v === 'object' && v !== null) ||
    Array.isArray(v),
  { message: 'doit être un node React' },
);

export const pluginRouteSchema = z.object({
  path: z.string().min(1),
  element: componentSchema,
});

export const pluginMenuItemSchema = z.object({
  id: z.string().min(1),
  to: z.string().min(1),
  labelKey: z.string().min(1),
  icon: iconSchema.optional(),
  order: z.number().int().default(100),
  submenu: reactNodeSchema.optional(),
  statusDot: componentSchema.optional(),
});

export const pluginManifestSchema = z.object({
  id: z
    .string()
    .regex(PLUGIN_ID_RE, "id : minuscules, chiffres et tirets + suffixe _vN optionnel (ex. 'storage', 'vm-view_v2')"),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'version semver (ex. 0.1.0)'),
  routes: z.array(pluginRouteSchema).optional(),
  menu: z.array(pluginMenuItemSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional(),
});
