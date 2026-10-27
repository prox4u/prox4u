---
name: network
description: Base de connaissance du plugin Network de Prox4u — page /topology : topologie auto-découverte (switches → nœuds → ponts → segments VLAN → VMs) en React Flow, inventaire réseaux→VMs, recherche unifiée, analyse d'impact incident, simulation PRA N-1, export CSV. Use when working on the network plugin (packages/web/src/plugins/network/), the /topology page, the React Flow graph (topology-flow.tsx), the network inventory table, or any network hypervision feature.
---

# Network — Base de connaissance

Page `/topology` : schéma de câblage **auto-découvert** via l'API PVE + **inventaire** des réseaux et des VMs qui les utilisent. Cible : managers/DSI en **hypervision réseau** (qui est branché où, ce qui tombe, l'impact). Migrated from legacy (Strangler Fig, étape 3).

> Architecture globale : voir le skill `general`.

## 1. Manifest (`index.ts`)
- id `network`, version 0.1.0. Route `/topology` → TopologyPage. Menu `nav.topology` (icône Network), order 20. `init()` : log uniquement.

## 2. Arborescence (5 fichiers)
| Fichier | Rôle |
|---|---|
| `pages/topology.tsx` | La page (~566 lignes) : état, sync URL, filtres, analyse d'incident, simulation PRA, + `ImpactPanel`, `VmList`, `Row`, `impactLabel`, `DetailPanel` |
| `components/topology-flow.tsx` | Graphe React Flow (~815 lignes) : layout hiérarchique déterministe, nœuds/arêtes custom, filtres, surbrillances |
| `components/network-inventory.tsx` | Table inventaire réseaux→VMs (vue, recherche, déroulé réseau, export CSV) |
| `components/multi-select.tsx` | Multi-sélection groupée générique (`MultiGroup {title, options}`) |

## 3. TopologyPage — état et sync URL
- État : `data` (topologies), `simSite`, `sel` (sélection graphe), `filterSel` (multi-select), `incidentKey`, `layoutKey` (remontage du graphe = « Réinitialiser le layout »).
- **Sync URL (deep-links partageables)** : `view` ('all' = vue agrégée multi-endpoints, sinon id d'endpoint) · `q` (recherche libre) · `net` (réseau sélectionné, encodé `vmbr0:10`, natif = `vmbr0:n`).
- Données : `fetchNetworkTopology()` au montage + bouton Actualiser. Cache serveur 5 min par endpoint.
- **Vue agrégée ('all')** : inventaire uniquement — pas de graphe (volontaire).

## 4. Filtres du graphe (priorité : le plus spécifique gagne)
1. **Réseau sélectionné** (`netSel` → `decodeNetSel` → `segmentKey(bridge, vlan)`) : segment exact — une VM est visible si elle a une interface sur ce (pont, VLAN).
2. **Recherche unifiée** (`q`) : restreint le graphe aux ponts + VLANs des lignes d'inventaire correspondantes (`buildNetworkInventory` + `filterNetworkRows`).
3. **Multi-sélection** (`filterSel`) : groupes VLANs (`v:<n>`), ponts (`b:<nom>`), NICs (`n:<nom>`).

## 5. Analyse d'impact incident (côté client, instantanée)
- Déroulé groupé par : switch (`sw:`), VLAN (`vlan:`), pont (`br:<node>:<bridge>`), NIC (`nic:<node>:<nic>`), nœud (`nd:`).
- `impactAnalysis(topo, failure)` de `@proxmox/shared` → `ImpactPanel` : VMs impactées (crit) + dégradées (warn).
- Réutilisée dans `DetailPanel` (`impactLabel`) pour afficher « ce qui tombe si cet élément tombe ».

## 6. Simulation PRA N-1
- Déroulé de site (désactivé si ≤ 1 site), issu du snapshot WS courant (`sites`).
- `failedNodes` = nœuds du site simulé → surbrillance dans le graphe ; bannière : impossible (crit) / absorption % (warn) / na ; `failoverVms` = VMs des nœuds tombés.

## 7. TopologyFlow (React Flow)
- `@xyflow/react` ; layout hiérarchique déterministe : switches → nœuds → ponts → segments VLAN → VMs.
- Props : `topology`, `failedNodes`, `filter` (`TopologyFilter {vlans, bridges, nics, networks}`), `impact`, `selection`/`onSelect` (`TopologySelection {kind, id}`).
- Segments de gestion surbrillés (icône Shield) ; légende dans la page.
- « Réinitialiser le layout » = incrémenter `layoutKey` → remontage (positions de drag remises à zéro).

## 8. DetailPanel (clic sur un élément)
Kinds : switch (sous-réseau, inféré, nœuds connectés, impact), node (état, IP, NICs, ponts), bridge (IP, sous-réseau, gateway, ports, VMs, impact), segment (pont, VLAN/natif, VMs), vm (état, nœud, table des interfaces → clic sur une interface = détail iface, trafic), iface (VM, pont, VLAN, MAC, IP, impact : down si aucune autre interface, sinon dégradé).
**IPs par interface** : la colonne/ligne IP affiche la **liste complète** (`agentIps[iface].join(', ')`, v4 + v6) quand le guest agent QEMU en rapporte, sinon l'IP de config (LXC statique). Source : `TopologyVm.agentIps` (voir §9).

## 9. Données consommées
- REST : `fetchNetworkTopology()` → `/api/network-topology` (cache serveur 5 min ; builder `buildTopology` dans `@proxmox/shared`, testé). Chaque `TopologyVm` porte `nets[].ip` **enrichi** (IP primaire guest agent, IPv4 d'abord) + `agentIps?` (liste complète par interface, QEMU en marche seulement).
- **IPs live guest agent** : le serveur (`computeTopology`) joint les interfaces du guest agent (`GET /nodes/{n}/qemu/{vmid}/agent/network-get-interfaces`, cache 60 s dans `ProxmoxClient.getVmAgentNets`) à la config PVE **par MAC** via `matchAgentNetsByMac` + `enrichVmAgentIps` (helpers shared/serveur, testés). LXC = IP statique de config ; VM arrêtée = aucun appel agent.
- Fonctions pures shared : `buildNetworkInventory`, `filterNetworkRows`, `impactAnalysis`, `segmentKey`, `matchAgentNetsByMac`, `primaryAgentIp`, `encodeNetSel`/`decodeNetSel`.
- WS : `useMulti()` pour les noms d'endpoints + PRA/sites (simulation).

## 10. i18n
Préfixes : `nav.topology`, `topo.*` (title, hint, loading, error, refresh, resetLayout, filter.*, incident.*, sim.*, legend.*, status.*, detail.*, iface.*, vlan.*), `nodes.*`, `common.*`.

## 11. Décisions & pièges
- **Switches inférés**, pas découverts : même nom de pont + même sous-réseau = même switch (builder pur dans shared). Affichés « inféré » dans le détail.
- Vue agrégée sans graphe (inventaire seul) — volontaire.
- Priorité des filtres stricte : réseau > recherche > multi-sélection (§4).
- Volumétrie VLAN (~200) : compter sur la recherche + le déroulé, ne pas tout rendre.
- VM→pont : parsing de `bridge=` des interfaces netN/mpN de la config VM (côté serveur).
- IPs par interface : jointure **par MAC** guest agent ↔ config PVE — les ifaces internes au guest (docker0, veth*, br-*) sont ignorées ; loopback (127./::1) et link-local (fe80::) filtrés au parsing. `agent/network-get-interfaces` est QEMU-only : LXC/VM arrêtée → `[]` (erreur PVE gérée).

## 12. Référence — les couches réseau de l'API PVE 9 (à connaître avant d'étendre)

Synthèse des systèmes de gestion réseau qui coexistent dans l'API PVE 9 (apportée par l'utilisateur, 2026-10-26). L'app ne consomme aujourd'hui que la couche nœud — utile dès qu'on aborde SDN/Fabrics ou le parsing de `/cluster/resources`.

### 12.1 Deux couches d'API fondamentales : nœud vs cluster SDN
| Critère | API Réseau Niveau Nœud | API SDN Niveau Cluster |
|---|---|---|
| Point d'entrée | `/nodes/{node}/network` | `/cluster/sdn/*` |
| Portée | Pile réseau d'un nœud physique individuel | Configuration réseau unifiée du cluster |
| Objets gérés | Ponts Linux (vmbr), bonds, VLANs, NICs physiques | Zones, VNets, Subnets, Controllers, IPAM, Fabrics |
| Propagation | Application immédiate sur le nœud cible | Écriture `/etc/pve/sdn/` + réplication CGFS, puis `Apply` pour déployer sur tous les nœuds |
| Portée des changements | Uniquement le nœud ciblé | Tous les nœuds du cluster |

→ Ce ne sont pas deux systèmes redondants mais **complémentaires** : l'app devra (le cas échéant) orchestrer les deux — créer un VNet via l'API SDN, attacher une VM à ce VNet, tout en gérant les bridges physiques sous-jacents via l'API nœud.

### 12.2 Coexistence active de deux formats de ressources (`sdn` legacy + `network`)
PVE 9 introduit un nouveau type de ressource `network` mais **continue d'émettre l'ancien type `sdn`** pour la compatibilité :
- **Legacy (`sdn`)** : schéma d'ID `sdn/{zone_id}` — toujours diffusé par les nœuds, même mis à jour, pour ne pas casser les clients existants.
- **Nouveau (`network`)** : ressource de 1er niveau pour toutes les entités réseau (y compris SDN) ; les nœuds récents le traitent en priorité mais basculent sur l'ancien format si nécessaire.

→ **Piège** : `/cluster/resources` peut renvoyer les deux formats **simultanément**. La désérialisation doit gérer `sdn` (legacy) tout en exploitant `network` pour les nouvelles entités (Fabrics…) — ne pas encore ignorer l'ancien format.

### 12.3 Parallélisme des rechargements SDN (RFC active — évolution à anticiper)
- **Problème** : appliquer une configuration SDN sur un grand cluster peut être long en séquentiel.
- **Solution proposée (RFC)** : lancer les tâches de rechargement réseau **en parallèle sur chaque nœud** via l'API.
- **Risque critique** : un rechargement qui casse le réseau de gestion d'un nœud n'affecte qu'un seul nœud en séquentiel, mais **peut faire tomber tout le cluster** si les rechargements sont simultanés.

→ Si on automatise l'application de configurations SDN : ne pas présupposer que l'API le fera toujours séquentiellement ; prévoir une limitation du parallélisme (ex. appliquer d'abord sur un nœud canari) pour éviter une défaillance en cascade.
