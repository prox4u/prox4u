---
name: audit
description: Plugin « Audit / best-practices » (audit v1) de prox4u — 2ᵉ score de CONFIGURATION (en complément du health score qui mesure les ressources) : moteur d'audit pur shared/audit.ts (17 checks : 7 Phase 1 + 5 Phase 2 + 5 Phase 3 — qemu_without_agent, privileged_containers, cpu_host_type, bridge_without_ports, thin_pool_overprovisioning, memory_overcommit, node_version_mismatch, autostart, stuck_snapshots, replication_state, bond_members, zfs_arc_max, disk_errors, disk_service_life, failed_units, pending_reboot, security_updates + score déterministe 100 − Σ pénalités crit−10/warn−5/info−1 borné [0,100] + libellés ≥80 Conforme/50–79 À améliorer/<50 À revoir), calculé par le POLLER à chaque tick et posé dans le snapshot WS (snapshot.audit) — la page /audit, la colonne « Audit » de la vue d'ensemble et le widget endpoint le lisent en direct, zéro API ; route GET /api/audit sert le snapshot ; constats CLIQUABLES vers la VM (/vms?tree=…&vm=…) / nœud (/e/:ep/n/:node) / stockage (/storage) / cluster (/e/:ep) ; **catalogue CHECKS_META (pourquoi/comment/seuil par check)** affiché repliable sur la page /audit ; **seuils + enable externalisés dans audit.json (hot-reload, pattern overcommit.json — défauts intégrés si absent)** ; données Phase 2 : autostart (config VM cache 1 h), snapshots (réchauffage de fond TTL 1 h, 1 appel/VM/h), réplication (GET /cluster/replication cache 5 min), bonds (getNetwork type « bond » + bond_slaves, cache 5 min), ZFS ARC max (table Telegraf zfs arcstats_c_max vs RAM, cache 5 min) ; données Phase 3 (agent Telegraf, cache 5 min) : SMART (table smart_device — erreurs secteurs + usure NVMe percentage_used), unités systemd en échec (table systemd_units active=failed/load=error), reboot en attente (table reboot_pending, script exec), mises à jour sécurité (table security_updates, script exec). Use when working on the audit plugin (packages/web/src/plugins/audit/), the /audit page, the shared audit engine (packages/shared/src/audit.ts), the GET /api/audit route, the audit score column in the overview, the audit gauge widget in the endpoint detail, the CHECKS_META catalog, the audit.json config, or the Phase 3 agent checks.
---

# Audit / best-practices — 2ᵉ score de configuration

> 📖 **Notice utilisateur** : module « Documentation » de l'app — route `/docs/audit`, source `packages/web/src/plugins/docs/content/audit.md`.

Plugin **`audit` v1** : un **2ᵉ score** (configuration) en **complément** du health score (qui
mesure les **ressources**). Il détecte les **écarts aux bonnes pratiques** sur les données
**déjà pollées** (API PVE) — chaque constat est **cliquable** vers la cible concernée.

> P3 (GitHub issue #6, label `feature`, **clôturée**). **Toutes les phases livrées et validées
> E2E** (17 checks : 7 API basiques + 5 API avancées + 5 agent Telegraf + page + score +
> constats cliquables + catalogue CHECKS_META + seuils externalisés `audit.json`). Agent
> Telegraf déployé sur les nœuds (`deploiement/60-telegraf-nodes.sh`, `DEPLOY.md` §10) —
> tables `reboot_pending`/`security_updates` alimentées, checks P3 opérationnels.
> Architecture globale : skill `general`. Analyse de référence ProxMenux + phasage P0→P5 :
> skill `monitoring-proxmenux` + GitHub issue #6 (P3 — suivi des tâches sur GitHub).

## 1. Architecture (décision « Option A »)

L'audit **vit dans le snapshot WS** — il est calculé par le **poller** à chaque tick, pas à la
volée par la route. La page, la colonne overview et le widget endpoint le lisent **en direct,
zéro API**.

```
Poller (tick 5 s) — pollEndpoint()
  ├─ données déjà pollées (nœuds, VMs, volumes de stockage, cluster)
  ├─ config VM étendue (unprivileged/cpuHost/autostart — cache 1 h, getResources)
  ├─ getAuditNetwork() → getNetwork() cache 5 min (bridges + bonds, networkCache)
  ├─ getAuditReplications() → GET /cluster/replication cache 5 min (replicationCache)
  ├─ getAuditZfsArc() → InfluxDB table `zfs` (arcstats_c_max) cache 5 min (zfsArcCache)
  ├─ getAuditSmartDisks() → InfluxDB table `smart_device` (secteurs + usure NVMe) cache 5 min
  ├─ getAuditFailedUnits() → InfluxDB table `systemd_units` (failed/error) cache 5 min
  ├─ getAuditReboot() → InfluxDB table `reboot_pending` (script exec) cache 5 min
  ├─ getAuditUpdates() → InfluxDB table `security_updates` (script exec) cache 5 min
  ├─ refreshSnapshotData() → getVmSnapshots/VM en BACKGROUND (TTL 1 h, single-flight,
  │   concurrence AGENT_CONCURRENCY) → st.snapshotAge (âge du snapshot le plus vieux)
  └─ runAudit(AuditInput)  [shared/audit.ts — fonction pure, 17 checks]
        │
        ▼
  DashboardSnapshot.audit : AuditScore   (poussé en WS + /api/dashboard)
        │
        ├─ page /audit (plugin audit)          — lit ep.snapshot.audit + CHECKS_META
        ├─ colonne « Audit » (overview v4)     — lit ep.snapshot.audit.score
        ├─ widget « Score de configuration »   — lit snapshot.audit (jauge + constats)
        └─ GET /api/audit (route)              — sert le snapshot (aucune logique dupliquée)
```

- **Moteur pur** `packages/shared/src/audit.ts` : types + 17 checks + `CHECKS_META`
  (catalogue 17 checks) + `runAudit` + score. **72 tests** (`audit.test.ts`).
- **Calcul poller** : `poller.ts` — `getAuditNetwork` (bridges+bonds) + `getAuditReplications`
  + `getAuditZfsArc` + `getAuditSmartDisks` + `getAuditFailedUnits` + `getAuditReboot` +
  `getAuditUpdates` + `refreshSnapshotData` + caches (`networkCache`, `replicationCache`,
  `zfsArcCache`, `smartDiskCache`, `failedUnitCache`, `rebootCache`, `updatesCache`,
  `st.snapshotAge`) + `runAudit` dans `pollEndpoint` + `audit` dans le snapshot.
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

### 3.1 Checks Phase 2 (5) — livrés

| Check | Sévérité | Condition | Cible | Source de la donnée |
|---|---|---|---|---|
| `guests.autostart` | info | **agrégé** : nb de VMs `autostart === false` (défaut PVE) > 0 → 1 constat `{ count }` | cluster | config VM (`autostart`, cache 1 h) — `undefined` (config inconnue) non compté |
| `guests.stuck_snapshots` | warn | `oldestSnapshotAgeDays > maxAgeDays` (défaut **7 j**) — `null` (pas de snapshot) non flagué | VM | `getVmSnapshots`/VM en background (TTL 1 h) → âge du snapshot le plus vieux |
| `guests.replication_state` | warn | job de réplication `lastResult !== 'ok'` OU `lastEndAgeHours > maxStalenessHours` (défaut **24 h**) OU jamais abouti | VM | `GET /cluster/replication` (cache 5 min) — **3 messageKeys** `.never`/`.failed`/`.stale` (pas de `null` en param i18n) |
| `network.bond_members` | warn | bond avec `slaves.length < minMembers` (défaut **2**) | nœud | `getNetwork` `type: "bond"` + `bond_slaves` (cache 5 min) |
| `system.zfs_arc_max` | warn | `arcMaxBytes / memTotalBytes × 100 > maxPctOfRam` (défaut **75 %**) | nœud | InfluxDB table `zfs` `arcstats_c_max` (fenêtre 1 h) vs RAM du nœud (cache 5 min) |

> **Tous les seuils + `enabled` sont externalisés dans `audit.json`** (hot-reload) — voir §13.
> Les checks Phase 2 sont **inactifs sans faux positif** si la donnée est absente (pas de
> snapshot → `null`, pas de job de réplication → `[]`, pas de bond → `[]`, pas de données ZFS →
> `[]`, `autostart` inconnu → non compté).

### 3.2 Checks Phase 3 (5) — livrés (agent Telegraf)

| Check | Sévérité | Condition | Cible | Source de la donnée |
|---|---|---|---|---|
| `disks.disk_errors` | crit | `healthOk === false` OU secteurs réalloués/en attente/non corrigeables/erreurs CRC > 0 | nœud | InfluxDB `smart_device` (dernier pt par (node,device), 1 h) — `null` (pas de SMART) non flagué |
| `disks.disk_service_life` | warn/crit | `percentageUsed ≥ critPct` (90) → crit · `≥ warnPct` (80) → warn | nœud | InfluxDB `smart_device` `percentage_used` (NVMe) — `null` (pas de NVMe) non flagué |
| `system.failed_units` | warn | unité `active='failed'` OU `load='error'` (1 constat/unité) | nœud | InfluxDB `systemd_units` (jamais `sub='dead'` — état de repos normal) |
| `system.pending_reboot` | info | `pending === 1` (fichier `/var/run/reboot-required`) | nœud | InfluxDB `reboot_pending` (script exec `prox4u-telegraf-reboot.sh`) |
| `system.security_updates` | info | `count ≥ warnCount` (5) correctifs de sécurité en attente | nœud | InfluxDB `security_updates` (script exec `prox4u-telegraf-updates.sh`, `apt list --upgradable`) |

> **Prérequis** : l'agent Telegraf déployé sur les nœuds (`deploiement/60-telegraf-nodes.sh`).
> Sans agent → tables absentes → checks **silencieux** (`[]`, pas de faux positif). `failed_units`
> et `disk_errors`/`disk_service_life` fonctionnent dès que `smart_device`/`systemd_units` sont
> présentes (déjà le cas) ; `pending_reboot`/`security_updates` nécessitent le **redéploiement**
> (2 nouveaux scripts exec).

## 4. Types (shared/audit.ts)

- `AuditSeverity = 'crit' | 'warn' | 'info'`.
- `AuditTarget { kind: 'vm'|'node'|'storage'|'cluster', endpointId, node?, vmid?, storage?, label }`.
- `AuditFinding { check, severity, messageKey, params?, target }` — `messageKey` = clé i18n
  `audit.finding.<check>`, `params` interpolées (ex. `{ name }`, `{ node, bridge }`, `{ ratio }`).
- `AuditScore { score, labelKey, counts { crit, warn, info }, checksPassed, checksTotal, findings[] }`.
- `AuditInput { endpointId, nodes, vms, storages, storageVolumes, bridges, bonds, replications,
  zfsArc, smartDisks, failedUnits, rebootPending, securityUpdates, overcommit, config }` —
  `config: AuditConfig` requis (seuils, défauts intégrés).
- `AuditBond { node, name, slaves[] }` · `AuditReplication { vmid, node, name, lastResult,
  lastEndAgeHours }` · `AuditZfsArc { node, arcMaxBytes, memTotalBytes }` — projections des
  données Phase 2 (seules les colonnes utiles aux checks).
- `AuditSmartDisk { node, device, model, healthOk: boolean|null, reallocatedSectors,
  pendingSectors, uncorrectableSectors, udmaCrcErrors, percentageUsed }` ·
  `AuditFailedUnit { node, name }` · `AuditRebootPending { node }` ·
  `AuditSecurityUpdates { node, count }` — projections des données Phase 3. `AuditInput` +=
  `smartDisks`/`failedUnits`/`rebootPending`/`securityUpdates`.
- `AuditCheckMeta { id, phase, severity, titleKey, whyKey, howKey, thresholdKey }` +
  `CHECKS_META: AuditCheckMeta[]` (catalogue **17** checks : 7 P1 + 5 P2 + 5 P3 — les P3 sont
  documentés mais non implémentés) — consommé par la page `/audit` (composant `CheckCatalog`).
- `AuditEndpointResult` / `AuditAllResponse` — formes de réponse de la route.

## 5. Cibles cliquables (deep-links)

`AuditTarget.kind` → navigation (page `/audit`, `go(target)` via `useNavigate`) :

| kind | Route |
|---|---|
| `vm` | `/vms?tree=<endpointId>/<node>&vm=<vmid>` |
| `node` | `/e/<endpointId>/n/<node>` |
| `storage` | `/storage` |
| `cluster` | `/e/<endpointId>` |

## 6. Données étendues

### 6.1 Config VM (cache 1 h, jointure `getResources`)

- `unprivileged` (LXC) + `cpuHost` (QEMU) + **`autostart`** ajoutés sur `VmConfigInfo` /
  `PveVmResource` / `VmSummary` (shared/types.ts).
- `prox4u-client.ts` : `fetchVmConfig` (cache config **1 h**) lit `c.unprivileged` (LXC
  `!== 0 && !== '0'`) + `c.cpu === 'host'` (QEMU) + `c.autostart === 1 || c.autostart === '1'`
  (défaut PVE = 0/désactivé → `false` ; absent de la config lue = `false`) ; jointure dans
  `getResources`. `autostart === undefined` = config inconnue (fetch échoué) → le check ne
  compte que `false`.

### 6.2 Sources Phase 2 (poller)

- **Snapshots** : `refreshSnapshotData` (background, single-flight par endpoint, concurrence
  `AGENT_CONCURRENCY`) appelle `getVmSnapshots`/VM, calcule l'âge du snapshot le plus vieux
  (`min(snaptime)`), stocke dans `st.snapshotAge: Map<vmid, { at, ageDays }>` (TTL
  `AUDIT_SNAPSHOT_TTL_MS` = **1 h** → 1 appel API/VM/h). Purge des VMs disparues.
  `VmSummary.oldestSnapshotAgeDays` = `st.snapshotAge.get(vmid)?.ageDays ?? null`.
- **Réplication** : `getReplicationStatus()` (client) → `GET /cluster/replication` (la liste
  inclut le statut `lastResult`/`lastEndTime` de chaque job — **pas** `/cluster/replication/status`).
  `getAuditReplications` (poller, cache 5 min) joint le nom/nœud de la VM + calcule
  `lastEndAgeHours` (le check reste pur).
- **Bonds** : `getNetwork` (client) extrait `type: "bond"` + `bond_slaves` (espace-séparé →
  tableau) → `NodeNetwork.bonds: NodeBond[]` (shared/network.ts). `getAuditNetwork` (poller,
  cache 5 min, partagé avec les bridges) → `AuditBond[]`.
- **ZFS ARC** : `getAuditZfsArc` (poller, cache 5 min) requête InfluxDB `raw.zfs`
  (`SELECT node, max(arcstats_c_max) ... WHERE time >= now() - INTERVAL '1 hour' GROUP BY node`)
  + joint la RAM du nœud (nodeHealth). Table absente (agent non déployé) → silencieux (`[]`).

### 6.3 Sources Phase 3 (poller, toutes cache 5 min, fenêtre 1 h, filtrées `node IN (…)`)

Même pattern que `getAuditZfsArc` : requête InfluxDB `raw`, **dernier point par clé**
(`ORDER BY time DESC` + `Map` qui garde la 1ʳᵉ ligne), `try/catch` silencieux si table absente
(`/not found/i`), `[]` mis en cache. Toutes filtrent par les nœuds de l'endpoint.

- **SMART** : `getAuditSmartDisks` → `raw.smart_device` (dernier pt par (node, device)) →
  `AuditSmartDisk[]`. `health_ok` NULL → `null` (inconnu, **pas** `false` — disque virtuel/RAID).
- **Unités systemd** : `getAuditFailedUnits` → `raw.systemd_units` filtré
  `active='failed' OR load='error'` (jamais `sub='dead'`) → `AuditFailedUnit[]`.
- **Reboot** : `getAuditReboot` → `raw.reboot_pending` (champ `pending` 0/1) → ne renvoie QUE
  les nœuds `pending=1` → `AuditRebootPending[]`.
- **Updates** : `getAuditUpdates` → `raw.security_updates` (champ `updates` = nb) →
  `AuditSecurityUpdates[]`.

> **Scripts exec** (déploies par `deploiement/60-telegraf-nodes.sh`, §10) :
> `prox4u-telegraf-reboot.sh` (lit `/var/run/reboot-required` → `reboot_pending pending=0/1i`)
> et `prox4u-telegraf-updates.sh` (`apt list --upgradable | grep -c security` →
> `security_updates updates=Ni`). Format line protocol : `mesure champ=Ni` (le tag `node` est
> ajouté par `global_tags` — cf. skill `node-sensors` §4, piège line protocol).

## 7. Web

- **Plugin `audit` v1** : `plugins/audit/index.ts` (manifest — route `/audit`, menu order **75**,
  icône `ShieldCheck`) + `pages/audit.tsx`.
- **Page `/audit`** : sélecteur d'endpoint (multi-endpoints seulement), carte **score** (grand
  chiffre teinté + badge + `Progress` + compteurs crit/warn/info + « X/Y checks passés »),
  section **constats** groupés par sévérité (section masquée si vide), chaque constat = ligne
  (badge sévérité + message i18n + **bouton cible cliquable** avec icône par kind), et
  **catalogue des checks** (composant `CheckCatalog` — §7.1).
- **Vue d'ensemble** (hypervision_v4 `pages/overview.tsx`) : **colonne « Audit »** dans le
  tableau endpoints — `auditScoreCell` (score coloré ≥80 ok / 50–79 warn / <50 crit, `—` si null).
- **Détail endpoint** (hypervision_v4 `pages/endpoint.tsx`) : **widget « Score de configuration »**
  — `components/audit-gauge.tsx` (`AuditGaugeBody` : jauge ECharts + liste constats, miroir de
  `HealthGaugeBody`) + slot `extra` = badge état. Ajouté au **catalogue** + à
  `ENDPOINT_DEFAULT_LAYOUT` (y19) — **pas** dans `DEFAULT_LAYOUT` (store/layout.ts) pour éviter
  un slot vide sur les pages legacy v1/v2/v3 qui l'utilisent en fallback.
- **Câblage** : `features.ts` (`USE_PLUGIN_AUDIT`, défaut ON) + `plugins.ts` (enregistrement).

### 7.1 Catalogue des checks (`CheckCatalog`)

Composant **repliable** en bas de la page `/audit` (déplié par défaut) — répond à la question
« **pourquoi ce check, comment il est calculé, quel est le seuil** ». 100 % piloté par
`CHECKS_META` (shared/audit.ts) : pour chaque entrée, une carte avec :

- **titre** (`titleKey`) + badge de **sévérité** + badge de **phase** (P1/P2/P3 — les P3 sont
  affichés en « à venir » grisé, non implémentés) ;
- **Pourquoi** (`whyKey`) — la raison du check (risque / bonne pratique) ;
- **Comment** (`howKey`) — la logique de détection (condition exacte) ;
- **Seuil** (`thresholdKey`) — le paramétrage courant (seuil + unité).

Aucune logique de check dans le web : le catalogue est une **vue du moteur** (les libellés
viennent de `CHECKS_META`, les textes de l'i18n).

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

**Phase 2** — libellés de constats ajoutés (fr/en) :
- `finding.guests.autostart` (`{ count }`), `finding.guests.stuck_snapshots`
  (`{ vm, ageDays }`), `finding.network.bond_members` (`{ node, name, members }`),
  `finding.system.zfs_arc_max` (`{ node, pct, threshold }`) ;
- `finding.guests.replication_state.never` / `.failed` / `.stale` — **3 clés distinctes**
  (pas une seule clé avec param `null` — react-i18next rend `null` comme la chaîne « null »).

**Phase 3** — libellés de constats ajoutés (fr/en) : `finding.disk_errors`
(`{ node, device, model }`), `finding.disk_service_life` (`{ node, device, pct }`),
`finding.failed_units` (`{ node, unit }`), `finding.pending_reboot` (`{ node }`),
`finding.security_updates` (`{ node, count, threshold }`) — clé = check sans préfixe de
catégorie (pattern `guests.qemu_without_agent` → `audit.finding.qemu_without_agent`).

**CHECKS_META** — pour les 17 checks : `audit.check.<id>.{title,why,how,threshold}` (fr/en) —
consommés par `CheckCatalog` (§7.1). Les `threshold` documentent le défaut **et** renvoient
vers `audit.json` (ex. « défaut 7 j — modifiable dans `audit.json` »).

## 10. Fichiers

- `packages/shared/src/audit.ts` (+ `audit.test.ts`, **72 tests**) — 17 checks + `CHECKS_META`
  (17) + `AuditConfig`/`DEFAULT_AUDIT_CONFIG` · `types.ts` (unprivileged/cpuHost/**autostart**/
  **oldestSnapshotAgeDays** + `PveReplicationStatus` + `HealthConfig` + `audit` dans
  `DashboardSnapshot`) · `network.ts` (**`NodeBond`**) · `index.ts` (exports fonctions + types
  dont `CHECKS_META`, `NodeBond`, `AuditSmartDisk`/`AuditFailedUnit`/`AuditRebootPending`/
  `AuditSecurityUpdates`, `AuditEndpointResult`/`AuditAllResponse`) · `auth.ts`
  (`DEFAULT_MODULES` +audit) · `i18n/{fr,en}.ts` (constats P2+P3 + `audit.check.<id>.*`)
- `packages/server/src/core/prox4u-client.ts` (`fetchVmConfig` +autostart + jointure, `getNetwork`
  +bonds, **`getReplicationStatus`**) · `core/data-source.ts` (`NodeNetwork.bonds`,
  `getReplicationStatus`) · `core/mock-source.ts` (`bonds: []`, `getReplicationStatus → []`) ·
  `core/poller.ts` (`getAuditNetwork` bridges+bonds + `getAuditReplications` + `getAuditZfsArc` +
  **`getAuditSmartDisks` + `getAuditFailedUnits` + `getAuditReboot` + `getAuditUpdates`** +
  `refreshSnapshotData` + caches `networkCache`/`replicationCache`/`zfsArcCache`/`smartDiskCache`/
  `failedUnitCache`/`rebootCache`/`updatesCache`/`st.snapshotAge` + `runAudit` dans `pollEndpoint`
  + `audit` dans le snapshot) · `core/config.ts` (**`reloadTunableConfigs`** — hot-reload
  audit.json/health.json) · `modules/audit/{index.ts,routes.ts}` · `modules/index.ts`
  (enregistrement) · `modules/auth/store.test.ts` (assertions liste modules +audit)
- **`deploiement/60-telegraf-nodes.sh`** (Phase 3) : 2 scripts exec ajoutés —
  `prox4u-telegraf-reboot.sh` (→ table `reboot_pending`) + `prox4u-telegraf-updates.sh`
  (→ table `security_updates`) + 2 blocs `[[inputs.exec]]` dans le `telegraf.conf` généré.
  **Redéploiement sur les nœuds requis** pour activer `pending_reboot`/`security_updates`.
- `packages/web/src/plugins/audit/{index.ts,pages/audit.tsx}` (**`CheckCatalog`**) ·
  `core/config/features.ts` (USE_PLUGIN_AUDIT) · `core/plugin/plugins.ts` ·
  `plugins/hypervision_v4/pages/{overview.tsx,endpoint.tsx}` ·
  `plugins/hypervision_v4/components/audit-gauge.tsx`
- **racine (config hot-reload, §13)** : `audit.json` + `audit.example.json` + `health.json` +
  `health.example.json` (commités, inclus dans le tarball de déploiement)
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
- **`autostart === undefined` ≠ désactivé** : `undefined` = config inconnue (fetch échoué) →
  **non compté** ; seul `false` (défaut PVE 0) est agrégé. Ne pas confondre « absent de la
  réponse » (inconnu) et « présent = 0 » (désactivé).
- **`replication_state` = 3 messageKeys** (`.never`/`.failed`/`.stale`) : une seule clé avec un
  param `null` rendrait la chaîne littérale « null » (react-i18next n'interpole pas `null`).
  Choisir la clé **avant** d'émettre le constat.
- **API PVE réplication** : `GET /cluster/replication` (la **liste** des jobs inclut déjà
  `lastResult`/`lastEndTime` par job) — **pas** `/cluster/replication/status` (qui n'existe pas
  sous cette forme). Header d'auth : `PVEAPIToken=user@realm!tokenid=value` — **exclamation**
  entre realm et tokenid (pas `=`).
- **`continue` (pas `return`) dans `reloadTunableConfigs`/`reloadOvercommitConfig`** : un `return`
  s'arrêtait au **premier** candidat absent (`<cwd>/audit.json`) → hot-reload muet en mode
  `server.sh` (`cwd=packages/server`). `continue` tente les candidats suivants (racine du repo).
  Le mode systemd (`WorkingDirectory=/opt/prox4u`) était insensible au bug.
- **Log du serveur** : le serveur servi est celui de **`server.sh`** → stdout dans
  **`logs/server.log`** (append `>>`). Les démarrages manuels (`> /tmp/opencode/prox4u-server.log`)
  sont des **doublons** (EADDRINUSE contre le serveur server.sh). Pour tuer sans se tuer :
  `pgrep -f "src/index[.]ts"` (astuce crochets — le shell ne se matche pas).
- **`count` = mot réservé SQL** : le champ de la table `security_updates` s'appelle
  **`updates`** (pas `count`) — `SELECT node, count FROM security_updates` serait ambigu avec
  l'agrégat `COUNT()`. Le script écrit `security_updates updates=Ni`.
- **`grep -c` → exit 1 si 0 match** : dans `prox4u-telegraf-updates.sh`, `grep -c security`
  retourne le code 1 quand il n'y a aucun correctif → avec `set -e` le script mourrait. D'où
  `count="$(... | grep -c security || true)"` + garde `[[ "$count" =~ ^[0-9]+$ ]] || count=0`.
- **`apt list --upgradable` lent** : le script updates lit les listes cachées (pas de réseau)
  mais peut prendre 1–3 s → le bloc `[[inputs.exec]]` dédié a `timeout = "30s"` (pas 10 s).
- **`health_ok` NULL ≠ `false`** (comme node-sensors) : un disque **sans SMART** (QEMU, RAID)
  renvoie NULL → mapper en `false` produirait un faux positif « disque en erreur ». Le poller
  fait `r.health_ok == null ? null : Boolean(r.health_ok)` ; le check ne flag que `=== false`.
- **Tables `reboot_pending`/`security_updates` absentes avant redéploiement** : les 2 checks
  sont **silencieux** (`[]`) tant que l'agent n'a pas été (re)déployé avec les nouveaux scripts
  exec — état attendu, pas une erreur. `failed_units`/`disk_errors`/`disk_service_life`
  fonctionnent dès que `systemd_units`/`smart_device` existent (déjà le cas).

## 12. À suivre

- **Phase 1 — LIVRÉE** : 7 checks API basiques.
- **Phase 2 — LIVRÉE** (C5) : `autostart`, `stuck_snapshots`, `replication_state`,
  `bond_members`, `zfs_arc_max` + `CHECKS_META` + `audit.json` (hot-reload).
- **Phase 3 — LIVRÉE + VALIDÉE E2E** (C6) : `disk_errors`, `disk_service_life` (usure SSD
  80/90 %), `failed_units`, `pending_reboot`, `security_updates` (warnCount 5) — base `raw` +
  pattern `node-sensors`. 2 scripts exec dans `deploiement/60-telegraf-nodes.sh`. Agent
  **déployé sur les nœuds** (tables `reboot_pending`/`security_updates` alimentées) —
  validation E2E : `security_updates` déclenche (23/20/20 ≥ 5), `failed_units` actif
  (`openipmi.service`, `ceph-mon@ProxSite1.service`), `pending_reboot` silencieux (tous 0),
  disques sains silencieux. **Les 17 checks sont tous opérationnels.**
- **Évolutions possibles** : règles d'alarme Centreon sur les constats (skill `centreon-nsca`),
  deep-link vers la page `/node-sensors` pour les constats disques (aujourd'hui cible = nœud).

## 13. Config externalisée (`audit.json` + `health.json`) — hot-reload

**Principe** : tous les **seuils, pénalités et `enabled`** des checks (audit **et** health
score) sont dans des **fichiers JSON** à la **racine du repo** — modifiables **sans restart**
(pattern `overcommit.json`). Les **défauts sont codés** (`DEFAULT_AUDIT_CONFIG` /
`DEFAULT_HEALTH_CONFIG`) : fichier absent ou clé manquante → défaut intégré (le serveur tourne
sans config).

### 13.1 `audit.json` (17 checks)

```jsonc
{
  "penalties": { "crit": 10, "warn": 5, "info": 1 },   // pénalités par sévérité
  "labelNominal": 80,   // ≥ 80 → « Conforme »
  "labelDegraded": 50,  // 50–79 → « À améliorer », < 50 → « À revoir »
  "checks": {
    "guests.qemu_without_agent":      { "enabled": true },
    "guests.privileged_containers":   { "enabled": true },
    "guests.cpu_host_type":           { "enabled": true },
    "network.bridge_without_ports":   { "enabled": true },
    "storage.thin_pool_overprovisioning": { "enabled": true },
    "system.memory_overcommit":       { "enabled": true },
    "system.node_version_mismatch":   { "enabled": true },
    "guests.autostart":               { "enabled": true },
    "guests.stuck_snapshots":         { "enabled": true, "maxAgeDays": 7 },
    "guests.replication_state":       { "enabled": true, "maxStalenessHours": 24 },
    "network.bond_members":           { "enabled": true, "minMembers": 2 },
    "system.zfs_arc_max":             { "enabled": true, "maxPctOfRam": 75 },
    "disks.disk_errors":              { "enabled": true },                 // P3
    "disks.disk_service_life":        { "enabled": true, "warnPct": 80, "critPct": 90 }, // P3
    "system.failed_units":            { "enabled": true },                 // P3
    "system.pending_reboot":          { "enabled": true },                 // P3
    "system.security_updates":        { "enabled": true, "warnCount": 5 }  // P3
  }
}
```

- `enabled: false` **désactive** un check (exclu du score, `checksTotal` diminue).
- Les seuils P3 (`warnPct`/`critPct`/`warnCount`) sont **déjà externalisés** — la Phase 3
  n'aura qu'à lire `config` (le check lit `AuditConfig`, pas des constantes).
- `audit.example.json` = **template** commenté (commité, copier → `audit.json` pour personnaliser).

### 13.2 `health.json` (Health Score + PRA)

```jsonc
{
  "thresholds": { "warn": 70, "crit": 90, "praWarn": 70, "praCrit": 100,
                  "healthNominal": 80, "healthDegraded": 50 },
  "penalties": { "nodeDown": 25, "quorumLost": 25, "qdeviceDown": 10,
                 "cpuCrit": 20, "cpuWarn": 10, "ramCrit": 20, "ramWarn": 10,
                 "diskCrit": 15, "diskWarn": 8, "praCrit": 20, "praWarn": 10 }
}
```

- `health.example.json` = template. Les i18n `health.penalty.*` sont **paramétrées**
  (`{{threshold}}`) → le libellé reflète le seuil effectif (pas codé en dur).

### 13.3 Hot-reload (mécanique)

- `config.ts` : **schemas zod** (`AuditConfigSchema`/`HealthConfigSchema`) + `reloadTunableConfigs()`
  appelé à **chaque tick** du poller. Compare le **mtime** de chaque fichier ; si modifié →
  re-parse + validation zod + remplacement de la config en mémoire + log
  `[info] audit.json modifié : configuration rechargée`.
- **Fichier invalide** (zod KO) → `[warn]` + **conserve la config précédente** (pas de crash,
  pas de reset aux défauts).
- **Chemin** : candidats `<cwd>/audit.json` puis **racine du repo** — `continue` (pas `return`)
  pour tenter tous les candidats (§11). En mode `server.sh` (`cwd=packages/server`) c'est la
  racine qui est trouvée ; en mode systemd (`WorkingDirectory=/opt/prox4u`) c'est `<cwd>`.
- **Aucun restart** : le changement s'applique au **tick suivant** (≤ 5 s). Vérifiable en prod :
  `grep "modifié : configuration rechargée" logs/server.log`.
