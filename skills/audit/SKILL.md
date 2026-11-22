---
name: audit
description: Plugin « Audit / best-practices » (audit v1) de prox4u — 2ᵉ score de CONFIGURATION (en complément du health score qui mesure les ressources) : moteur d'audit pur shared/audit.ts (7 checks Phase 1 : qemu_without_agent, privileged_containers, cpu_host_type, bridge_without_ports, thin_pool_overprovisioning, memory_overcommit, node_version_mismatch + score déterministe 100 − Σ pénalités crit−10/warn−5/info−1 borné [0,100] + libellés ≥80 Conforme/50–79 À améliorer/<50 À revoir), calculé par le POLLER à chaque tick et posé dans le snapshot WS (snapshot.audit) — la page /audit, la colonne « Audit » de la vue d'ensemble et le widget endpoint le lisent en direct, zéro API ; route GET /api/audit sert le snapshot ; constats CLIQUABLES vers la VM (/vms?tree=…&vm=…) / nœud (/e/:ep/n/:node) / stockage (/storage) / cluster (/e/:ep) ; config VM étendue (unprivileged LXC + cpu=host QEMU, cache 1 h). Use when working on the audit plugin (packages/web/src/plugins/audit/), the /audit page, the shared audit engine (packages/shared/src/audit.ts), the GET /api/audit route, the audit score column in the overview, the audit gauge widget in the endpoint detail, or adding Phase 2/3 checks.
---

# Audit / best-practices — 2ᵉ score de configuration

Plugin **`audit` v1** : un **2ᵉ score** (configuration) en **complément** du health score (qui
mesure les **ressources**). Il détecte les **écarts aux bonnes pratiques** sur les données
**déjà pollées** (API PVE) — chaque constat est **cliquable** vers la cible concernée.

> P3 (GitHub issue #6, label `feature`). **Phase 1 livrée** (7 checks API + page + score +
> constats cliquables). Phases 2/3 à venir (checks API supplémentaires + checks agent Telegraf).
> Architecture globale : skill `general`. Analyse de référence ProxMenux + phasage P0→P5 :
> skill `monitoring-proxmenux` + GitHub issue #6 (P3 — suivi des tâches sur GitHub).

## 1. Architecture (décision « Option A »)

L'audit **vit dans le snapshot WS** — il est calculé par le **poller** à chaque tick, pas à la
volée par la route. La page, la colonne overview et le widget endpoint le lisent **en direct,
zéro API**.

```
Poller (tick 5 s) — pollEndpoint()
  ├─ données déjà pollées (nœuds, VMs, volumes de stockage, cluster)
  ├─ getAuditBridges() → getNetwork() cache 5 min (AUDIT_NETWORK_TTL_MS, networkCache)
  └─ runAudit(AuditInput)  [shared/audit.ts — fonction pure]
        │
        ▼
  DashboardSnapshot.audit : AuditScore   (poussé en WS + /api/dashboard)
        │
        ├─ page /audit (plugin audit)          — lit ep.snapshot.audit
        ├─ colonne « Audit » (overview v4)     — lit ep.snapshot.audit.score
        ├─ widget « Score de configuration »   — lit snapshot.audit (jauge + constats)
        └─ GET /api/audit (route)              — sert le snapshot (aucune logique dupliquée)
```

- **Moteur pur** `packages/shared/src/audit.ts` : types + 7 checks + `runAudit` + score.
  **35 tests** (`audit.test.ts`).
- **Calcul poller** : `poller.ts` — `getAuditBridges` + `networkCache` + `runAudit` dans
  `pollEndpoint` + `audit` dans le snapshot.
- **Route `GET /api/audit`** (`modules/audit/routes.ts`) : sert `snapshot.audit` —
  signature `(app, poller)` (pas de `ctx`), **aucune logique de calcul dupliquée**.

## 2. Formule du score (déterministe, documentée)

- `score = 100 − Σ pénalités`, **borné [0, 100]**.
- Pénalités par sévérité : **crit −10 · warn −5 · info −1** (`AUDIT_PENALTIES`).
- Libellés : **≥80 Conforme** (`audit.label.compliant`) · **50–79 À améliorer**
  (`audit.label.toImprove`) · **<50 À revoir** (`audit.label.toReview`) — `auditLabelKey`.
- Constats **triés par sévérité** (crit → warn → info). `checksPassed` = nb de checks sans
  constat ; `checksTotal` = nb de checks exécutés.

## 3. Checks Phase 1 (7)

| Check | Sévérité | Condition | Cible |
|---|---|---|---|
| `guests.qemu_without_agent` | crit | QEMU **en marche** + `agentActive === false` (pas `null` — inconnu = pas de faux positif) | VM |
| `guests.privileged_containers` | warn | LXC + `unprivileged === false` | VM |
| `guests.cpu_host_type` | info | QEMU + `cpuHost === false` | VM |
| `network.bridge_without_ports` | warn | pont avec `bridge_ports` vide | nœud |
| `storage.thin_pool_overprovisioning` | warn/crit | volume **thin** (`thinCapable`) + `hasDisks` + `tone` warn/crit (ratio surallocation) | stockage |
| `system.memory_overcommit` | warn/crit | nœud en ligne + ratio RAM `(ramAlloc + provision·memTotal)/memTotal` > seuil (`overcommit.ram` okMax 1 / warnMax 1.2) | nœud |
| `system.node_version_mismatch` | info | ≥2 versions PVE distinctes sur les nœuds **en ligne** | cluster |

> `memory_overcommit` réutilise l'échelle `overcommit.ram` (provision `hostRamProvisionPct` 10 %).
> `thin_pool_overprovisioning` réutilise le `tone` déjà calculé par `buildStorageVolumes`.

## 4. Types (shared/audit.ts)

- `AuditSeverity = 'crit' | 'warn' | 'info'`.
- `AuditTarget { kind: 'vm'|'node'|'storage'|'cluster', endpointId, node?, vmid?, storage?, label }`.
- `AuditFinding { check, severity, messageKey, params?, target }` — `messageKey` = clé i18n
  `audit.finding.<check>`, `params` interpolées (ex. `{ name }`, `{ node, bridge }`, `{ ratio }`).
- `AuditScore { score, labelKey, counts { crit, warn, info }, checksPassed, checksTotal, findings[] }`.
- `AuditInput { endpointId, nodes, vms, storages, storageVolumes, bridges, overcommit }`.
- `AuditEndpointResult` / `AuditAllResponse` — formes de réponse de la route.

## 5. Cibles cliquables (deep-links)

`AuditTarget.kind` → navigation (page `/audit`, `go(target)` via `useNavigate`) :

| kind | Route |
|---|---|
| `vm` | `/vms?tree=<endpointId>/<node>&vm=<vmid>` |
| `node` | `/e/<endpointId>/n/<node>` |
| `storage` | `/storage` |
| `cluster` | `/e/<endpointId>` |

## 6. Données étendues (config VM)

- `unprivileged` (LXC) + `cpuHost` (QEMU) ajoutés sur `VmConfigInfo` / `PveVmResource` /
  `VmSummary` (shared/types.ts).
- `prox4u-client.ts` : `fetchVmConfig` (cache config **1 h**) lit `c.unprivileged` (LXC
  `!== 0 && !== '0'`) + `c.cpu === 'host'` (QEMU) ; jointure dans `getResources`.

## 7. Web

- **Plugin `audit` v1** : `plugins/audit/index.ts` (manifest — route `/audit`, menu order **75**,
  icône `ShieldCheck`) + `pages/audit.tsx`.
- **Page `/audit`** : sélecteur d'endpoint (multi-endpoints seulement), carte **score** (grand
  chiffre teinté + badge + `Progress` + compteurs crit/warn/info + « X/Y checks passés »),
  section **constats** groupés par sévérité (section masquée si vide), chaque constat = ligne
  (badge sévérité + message i18n + **bouton cible cliquable** avec icône par kind).
- **Vue d'ensemble** (hypervision_v4 `pages/overview.tsx`) : **colonne « Audit »** dans le
  tableau endpoints — `auditScoreCell` (score coloré ≥80 ok / 50–79 warn / <50 crit, `—` si null).
- **Détail endpoint** (hypervision_v4 `pages/endpoint.tsx`) : **widget « Score de configuration »**
  — `components/audit-gauge.tsx` (`AuditGaugeBody` : jauge ECharts + liste constats, miroir de
  `HealthGaugeBody`) + slot `extra` = badge état. Ajouté au **catalogue** + à
  `ENDPOINT_DEFAULT_LAYOUT` (y19) — **pas** dans `DEFAULT_LAYOUT` (store/layout.ts) pour éviter
  un slot vide sur les pages legacy v1/v2/v3 qui l'utilisent en fallback.
- **Câblage** : `features.ts` (`USE_PLUGIN_AUDIT`, défaut ON) + `plugins.ts` (enregistrement).

## 8. Visibilité du module (piège)

Un module est **visible** s'il est **autorisé** (globallyEnabled OU attribué à un groupe) **ET
sélectionné** dans les `userModules` de l'user (`computeVisibleVersionIds` = autorisés ∩
sélectionnés). Nouveau module → **deux** actions :
1. Ajouter à `DEFAULT_MODULES` (shared/auth.ts, `globallyEnabled: true`) — la **réconciliation**
   au chargement l'ajoute au `data/auth.json`.
2. Ajouter aux `userModules` de l'user (sinon `ModuleRoute` redirige `/profile`).

> test-admin = `u_a06630b1584d` — `audit` ajouté à ses `userModules` dans `data/auth.json`.

## 9. i18n

`nav.audit` + `audit.*` (fr/en) : `title`, `score`, `scoreDesc`, `scoreCol`, `label.{compliant,
toImprove,toReview}`, `endpoint`, `noData`, `checksPassed`, `findings.{title,desc,singular,
plural}`, `severity.{crit,warn,info}`, `openTarget`, `empty`, `finding.<check>` (par check).

## 10. Fichiers

- `packages/shared/src/audit.ts` (+ `audit.test.ts`, 35 tests) · `types.ts` (unprivileged/cpuHost
  + `audit` dans `DashboardSnapshot`) · `index.ts` (exports fonctions + types dont
  `AuditEndpointResult`/`AuditAllResponse`) · `auth.ts` (`DEFAULT_MODULES` +audit) · `i18n/{fr,en}.ts`
- `packages/server/src/core/prox4u-client.ts` (`fetchVmConfig` + jointure) · `core/poller.ts`
  (`getAuditBridges` + `networkCache` + `runAudit` dans `pollEndpoint` + `audit` dans le snapshot)
  · `modules/audit/{index.ts,routes.ts}` · `modules/index.ts` (enregistrement) ·
  `modules/auth/store.test.ts` (4 assertions liste modules +audit)
- `packages/web/src/plugins/audit/{index.ts,pages/audit.tsx}` · `core/config/features.ts`
  (USE_PLUGIN_AUDIT) · `core/plugin/plugins.ts` · `plugins/hypervision_v4/pages/{overview.tsx,
  endpoint.tsx}` · `plugins/hypervision_v4/components/audit-gauge.tsx`
- `data/auth.json` (module audit catalogue + userModules test-admin)

## 11. Pièges (corrigés — ne pas réintroduire)

- **Nom du package** : `@prox4u/shared` (PAS `@proxmox/shared`) — 45 usages serveur / 205 web.
  Écrire `@proxmox/shared` → TS2307.
- **`/audit` → `/profile`** : module non visible (voir §8) — ajouter à `DEFAULT_MODULES` **+**
  aux `userModules` de l'user.
- **Types absents du dist** : `AuditEndpointResult`/`AuditAllResponse` doivent être dans
  l'export `index.ts` du shared + **rebuild shared** (consommé via dist tsup).
- **`agentActive === null` ≠ inactif** : les 1ers ticks (cache pas réchauffé) → `null` = inconnu,
  **pas** de faux positif (seul `false` est flagué).
- **Pont sans port ≠ toujours un bug** : un pont NFS/volontaire sans port physique est flagué
  (warn) — c'est un **constat à revoir**, pas une erreur.

## 12. À suivre (Phases 2/3)

- **Phase 2 — checks API supplémentaires** : `autostart`, `stuck_snapshots`,
  `replication_state`, `bond_members`, `zfs_arc_max`.
- **Phase 3 — checks agent (via Telegraf)** : `disk_errors`, `disk_service_life`,
  `failed_units`, `pending_reboot`, `security_updates` (réutiliser la base `raw` + le pattern
  du plugin `node-sensors`).
