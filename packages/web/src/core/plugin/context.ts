import * as apiClient from '../api/apiClient';
import { eventBus } from './eventBus';
import { hostLogger } from './logger';
import type { PluginContext } from './types';

/** Contexte de base injecté dans chaque plugin (le loader y ajoute un logger dédié). */
export function createPluginContext(): PluginContext {
  return { api: apiClient, eventBus, logger: hostLogger };
}
