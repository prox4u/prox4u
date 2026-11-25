# Inventaire Proxmox

Inventaire **consolidé de tout le parc multi-endpoints** : **une machine par ligne** (QEMU + LXC), croisant les ressources en direct, les données de l'agent invité (OS réel, disques, interfaces/IPs) et la configuration Proxmox (tags, notes).

- **Qui s'en sert** : la DSI / l'admin infrastructure qui a besoin d'une vue unique et à jour du parc (inventaire d'actifs, recherche d'IPs, contrôle de l'état des agents).
- **Ce que ça fait** : Prox4u agrège toutes les machines de tous les endpoints Proxmox dans une seule table filtrable, triable et exportable (TXT / CSV / JSON).

---

## Comment s'en servir

### 1. Ouvrir l'inventaire

1. Dans le menu de gauche, ouvrez **Inventaire Proxmox** (route `/proxmox-inventory`).
2. La page affiche :
   - un champ de **recherche** globale (nom, hostname, VMID, nœud, OS, IP, tag, note…) ;
   - **9 cartes de résumé** : total, affichées, running, stopped, RAM allouée / utilisée, cœurs CPU, CPU moyen, et **Agent OK n/total** ;
   - la table : **une ligne par machine**, tous endpoints confondus (la colonne « Host » indique l'endpoint d'origine).

![Inventaire Proxmox — vue consolidée multi-endpoints](/screenshots/proxmox-inventory.png)

### 2. Rechercher et filtrer

1. Saisissez un texte dans la **recherche** : elle couvre toutes les colonnes (nom, hostname, VMID, nœud, type, statut, OS, IPs, tags, notes), insensible à la casse.
2. Utilisez les **filtres par colonne** (dans le sommet de chaque colonne) :
   - **Nœud**, **Type**, **Statut** : liste des valeurs présentes dans l'inventaire ;
   - **Agent PVE** : valeurs fixes **actif** / **inactif** / **n-a** ;
   - **CPU**, **RAM**, **Disque** : plages min / max.
3. **Triez** en cliquant sur un en-tête de colonne (nom, VMID, nœud, type, statut, agent, CPU, RAM, uptime, disques…).

### 3. Exporter la vue filtrée

1. Choisissez le format : **CSV**, **TXT** ou **JSON**.
2. Cliquez sur **Exporter** : le fichier téléchargé ne contient que **les lignes actuellement affichées** (après recherche et filtres), pas tout l'inventaire.
3. Utilisez **Rafraîchir** pour forcer le rafraîchissement des données.

---

## Ce qui se passe en fond

Prox4u croise, pour chaque machine, trois sources :

- les **ressources en direct** (statut, CPU, RAM, uptime) ;
- l'**agent invité** (QGA) : OS réel, disques par filesystem, interfaces et IPs ;
- la **configuration Proxmox** : tags, notes, type d'OS (repli quand l'agent est indisponible).

| Événement | Quand | Détail |
|---|---|---|
| Rafraîchissement de l'inventaire | toutes les **5 min** par endpoint | recalcul en arrière-plan des données agent (OS, disques, IPs) |
| Chargement de la page | à chaque visite | sert la dernière valeur connue (même périmée) + lance le recalcul en arrière-plan |

- **Cache 5 min par endpoint (stale-while-revalidate)** : la page ne bloque **jamais** derrière un calcul agent — la dernière valeur connue est affichée immédiatement, le recalcul part en arrière-plan.
- **Best-effort** : une VM arrêtée ou sans agent ne provoque pas d'erreur — ses disques et IPs sont simplement vides.
- **Concurrence bornée** : une VM lente ne retient que quelques appels agent à la fois, pas tout l'inventaire.

**Flux** : API Proxmox (ressources + agent invité) → cache serveur (5 min) → `GET /api/proxmox-inventory` → table.

---

## Configuration (récap)

| Paramètre | Où | Défaut |
|---|---|---|
| Cache de l'inventaire | serveur (interne) | 5 min par endpoint |
| Timeout des appels agent | serveur (interne) | 8 s par VM |
| Concurrence des appels agent | serveur (interne) | bornée (une VM lente ne bloque pas les autres) |

> Ce module n'a **aucun réglage côté utilisateur** : c'est une vue en lecture seule du parc.

---

## Limites connues

- **OS réel** : lu via l'agent invité ; pour les VMs arrêtées ou sans agent, c'est la configuration Proxmox qui sert de repli (moins précis).
- **Agent PVE « n-a »** : les conteneurs LXC, les VMs arrêtées et les templates n'ont pas d'agent invité — c'est normal, pas une panne.
- **Export de la vue filtrée uniquement** : le fichier exporté contient les lignes affichées, pas l'inventaire complet.
- **Démarrage à froid** : au premier chargement après un redémarrage du serveur, la page peut prendre quelques secondes (les caches agent ne sont pas encore chauds).

---

## FAQ / dépannage

**Pourquoi la colonne « Agent PVE » est-elle en rouge « inactif » sur une VM démarrée ?**
La VM tourne (QEMU) mais l'agent invité n'est pas démarré ou n'est pas joignable dans le système d'exploitation. Vérifiez le service agent dans la VM (par ex. `qemu-guest-agent` sous Linux).

**Pourquoi « n-a » dans la colonne agent ?**
Normal pour les conteneurs LXC, les VMs arrêtées et les templates : ils n'ont pas d'agent invité. Si vous voyez « n-a » sur une VM QEMU démarrée juste après un redémarrage du serveur, le cache agent n'est peut-être pas encore réchauffé — cliquez sur **Rafraîchir**.

**Pourquoi les disques ou les IPs sont-ils vides sur certaines VMs ?**
L'agent invité ne répond pas (VM arrêtée, agent non installé). La ligne reste affichée avec les données disponibles (statut, CPU, RAM, tags…).

**Mon export ne contient pas toutes mes VMs ?**
L'export n'exporte que la **vue filtrée**. Videz la recherche et les filtres de colonnes, puis exportez à nouveau.

**Les données semblent anciennes ?**
L'inventaire est mis en cache **5 minutes** par endpoint. Cliquez sur **Rafraîchir** : la dernière valeur connue s'affiche immédiatement et le recalcul part en arrière-plan.
