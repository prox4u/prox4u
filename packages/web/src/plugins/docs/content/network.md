# Topologie réseau

Schéma de câblage **auto-découvert** depuis l'API Proxmox (switches → nœuds → ponts → segments VLAN → VMs) et **inventaire** des réseaux et des VMs qui les utilisent.

- **Qui s'en sert** : le manager / DSI en **hypervision réseau** — qui est branché où, ce qui tombe si un élément tombe, et l'impact sur les VMs.
- **Ce que ça fait** : Prox4u lit la configuration réseau de tous vos nœuds Proxmox (NICs, ponts, VLANs, branchements VM) et la dessine sous forme de schéma interactif. Vous pouvez y simuler un incident (switch, VLAN, pont, NIC, nœud, site) et voir immédiatement quelles VMs sont perdues ou dégradées.

---

## Comment s'en servir

### 1. Ouvrir la page et lire le schéma

1. Ouvrez **Topologie réseau** dans le menu (route `/topology`).
2. En haut, choisissez la **vue** : **Tous les serveurs** (vue agrégée, inventaire seul) ou un **endpoint** précis (cluster Proxmox).
3. Le schéma s'affiche en hiérarchie : **switches** → **nœuds Proxmox** → **ponts Linux** → **segments VLAN** → **VMs / conteneurs**.
4. La **légende** sous le schéma explique les éléments : switch (inféré), nœud, pont, segment, réseau interne Proxmox (icône bouclier), VM en marche / arrêtée.
5. Le bouton **Actualiser** recharge la topologie (le serveur met en cache 5 minutes par endpoint).
6. Après avoir déplacé des éléments à la souris, **Réinitialiser le layout** remet le schéma en ordre.

![Topologie réseau — schéma auto-découvert](/screenshots/network-topology.png)

### 2. Rechercher et filtrer

- **Recherche unifiée** (champ en haut) : tapez un réseau, un VLAN, une IP, une VM, un `vmid`… — l'inventaire **et** le schéma sont restreints aux résultats.
- **Réseau** (déroulé) : sélectionnez un segment exact (pont + VLAN) — le schéma ne montre que ce segment et la ligne d'inventaire correspondante se déplie automatiquement.
- **Filtrer par…** (multi-sélection) : **VLANs**, **Ponts**, **NICs physiques**.
- Si plusieurs filtres sont actifs, le plus spécifique gagne : réseau sélectionné > recherche > multi-sélection.

### 3. Consulter l'inventaire réseaux → VMs

Le tableau au-dessus du schéma liste **une ligne par réseau** (segment pont + VLAN) avec :

- **Type** : Interne Proxmox ou Externe ;
- **Sous-réseau**, **Nœuds** connectés, **VMs** (en marche / arrêtées), **Trafic** ;
- **État** : Nominal / Dégradé / Hors service / Inconnu ;
- **Impact si ça tombe** : combien de VMs seraient perdues ou dégradées.

Cliquez sur une ligne pour la **déplier** et voir les VMs qui utilisent le réseau (interface, `MAC`, `IP`). Le bouton **Export CSV** exporte la vue courante : une ligne par interface VM sur un réseau (serveur, réseau, VLAN, type, sous-réseau, nœud, `vmid`, VM, interface, IP, `MAC`, état) — fichier `inventaire-reseaux-<date>.csv`.

### 4. Simuler un incident réseau

1. Dans le déroulé **Incident réseau**, choisissez l'élément qui « tombe » : **Switch**, **VLAN**, **Pont**, **NIC physique** ou **Nœud**.
2. Le schéma surbrille l'élément et son voisinage, et un panneau récapitule :
   - **VMs impactées (hors service)** — elles perdent toutes leurs interfaces ;
   - **VMs dégradées** — elles en perdent une mais en conservent d'autres.
3. Le clic sur n'importe quel élément du schéma affiche aussi ses détails, dont « VMs impactées si ça tombe ».

### 5. Simuler un PRA N-1 (chute d'un site)

1. Dans le déroulé **Simulation PRA N-1**, choisissez un **site** (désactivé si l'endpoint n'a qu'un seul site).
2. Les nœuds du site simulé sont surbrillés dans le schéma, et une bannière indique :
   - **bascule impossible** — capacité insuffisante ailleurs (rouge) ;
   - **X VMs à basculer — capacité libre des autres sites utilisée à Y %** (orange).

### 6. Consulter les détails d'un élément

Le clic sur un élément du schéma ouvre le panneau **Détails** :

- **Switch** (inféré) : sous-réseau, nœuds connectés, impact ;
- **Nœud** : état, IP, NICs physiques, ponts ;
- **Pont** : IP, sous-réseau, passerelle, ports, VMs branchées, impact ;
- **Segment** : pont, VLAN (ou natif), VMs ;
- **VM** : état, nœud, table des interfaces — le clic sur une interface donne ses détails (pont, VLAN, `MAC`, `IP`, trafic) et son impact : **VM coupée** si c'est sa seule interface, **VM dégradée** sinon.

---

## Ce qui se passe en fond

- **Source** : API Proxmox (lecture seule) — NICs, ponts, VLANs et branchements VM (parsing de `bridge=` des interfaces de la configuration VM).
- **Cache serveur** : la topologie est mise en cache **5 minutes par endpoint** ; **Actualiser** force le rechargement.
- **IPs live (guest agent)** : pour chaque VM QEMU en marche, Prox4u interroge le **guest agent** (`network-get-interfaces`, cache **60 s**) et joint le résultat à la configuration Proxmox **par `MAC`** pour afficher les vraies `IP` de chaque interface (IPv4 + IPv6). VM arrêtée ou LXC : IP de configuration statique.
- **Switches inférés** : l'API Proxmox ne voit pas les switches physiques — Prox4u les **infère** (même nom de pont + même sous-réseau = même switch) et le signale « inféré » dans les détails.
- **Analyse d'incident et simulation PRA** : calculées **instantanément côté navigateur** à partir de la topologie courante et du snapshot PRA des sites (WebSocket) — aucun appel serveur.

| Événement | Quand | Détail |
|---|---|---|
| Chargement de la topologie | ouverture de la page + bouton **Actualiser** | `/api/network-topology`, cache serveur 5 min par endpoint |
| Rafraîchissement des IPs live | à chaque construction de la topologie | guest agent QEMU, cache 60 s par VM |
| Analyse d'incident / PRA | au choix dans les déroulés | instantané, calculé dans le navigateur |

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Vue (Tous les serveurs / endpoint) | haut de page (encodée dans l'URL) | Tous les serveurs |
| Recherche / réseau / filtres | haut de page (encodés dans l'URL) | aucun |
| Cache topologie | serveur | 5 min par endpoint |
| Cache IPs guest agent | serveur | 60 s |

---

## Limites connues

- **Switches inférés, pas découverts** : l'API Proxmox n'expose pas les switches physiques. L'inférence (même pont + même sous-réseau) peut fusionner deux switches physiques ou en scinder un.
- **Vue agrégée sans schéma** : « Tous les serveurs » n'affiche que l'inventaire (volontaire) — choisissez un endpoint pour voir le schéma.
- **Volumétrie VLAN** : avec beaucoup de VLANs (~200), le schéma compte sur la recherche et les filtres — tout n'est pas rendu d'un coup.
- **IPs live** : seulement pour les VM QEMU **en marche** avec le guest agent installé. LXC = IP statique de configuration ; VM arrêtée = aucune IP live.
- **Lecture seule** : le module ne modifie jamais le réseau (aucune action).
- **Simulation PRA** : nécessite au moins **2 sites** sur l'endpoint, sinon désactivée.

---

## FAQ / dépannage

**Pourquoi mes switches sont-ils « inférés » ?**
L'API Proxmox ne voit pas les switches physiques. Prox4u regroupe par nom de pont + sous-réseau : même pont + même sous-réseau = même switch. Le panneau de détails l'indique (« inféré »).

**Pourquoi n'y a-t-il pas de schéma dans la vue « Tous les serveurs » ?**
Volontaire : la vue agrégée est un inventaire seul (tous les endpoints). Choisissez un endpoint précis pour afficher le schéma.

**Pourquoi ma VM n'affiche pas d'IP ?**
Les IPs live viennent du **guest agent** (QEMU uniquement, VM en marche). Sans agent installé ou VM arrêtée, seule l'IP de la configuration Proxmox est affichée (LXC : IP statique).

**Le schéma est désordonné après avoir déplacé des éléments ?**
Le bouton **Réinitialiser le layout** relance le layout hiérarchique d'origine.

**Comment partager une vue avec un collègue ?**
L'URL est partageable : la vue (endpoint / tous les serveurs), la recherche et le réseau sélectionné sont encodés dans l'URL (`view`, `q`, `net`).

**Que signifie « Impact si ça tombe » ?**
Le nombre de VMs qui seraient **perdues** (toutes leurs interfaces coupées) ou **dégradées** (au moins une interface restante) si ce réseau ou cet élément tombait — calculé instantanément à partir de la topologie courante.
