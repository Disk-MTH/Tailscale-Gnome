# Réécriture du système de notifications

**Date** : 2026-07-26
**Statut** : validé, prêt pour le plan d'implémentation
**Périmètre** : `lib/toast.js`, `lib/menu.js`, `extension.js`, `prefs.js`, le schéma GSettings, `stylesheet.css`, plus trois modules neufs.

Ce document est rédigé en français parce qu'il sert de support de relecture. Tout ce qui est
livré (code, commentaires, chaînes traduisibles, README) reste en anglais.

---

## 1. Objectif

Le système actuel n'a qu'un seul rendu : une bulle OSD en bas d'écran qui disparaît au bout
de quelques secondes. Une notification manquée est perdue définitivement.

On veut deux modes au choix de l'utilisateur :

- **Persistent** (défaut) — les notifications natives de GNOME, groupées sous une seule
  entrée « Tailscale » dans la liste de notifications, formant un historique consultable
  des N derniers évènements.
- **Toast** — le comportement actuel, avec sa durée d'affichage réglable.

Plus un interrupteur on/off par famille d'évènements, et la fin du spam de notifications
au changement de compte.

L'historique ne survit pas à la déconnexion de session. C'est assumé : il vaut mieux un
pseudo-historique volatil que rien.

---

## 2. Faits vérifiés dans GNOME Shell 50

Ces quatre points portent tout le design. Ils ont été relevés dans
`js/ui/messageTray.js` de la branche `gnome-50`, pas de mémoire.

**La queue demandée est du natif.** Un `MessageTray.Source` est exactement le conteneur
recherché — une entrée groupée dans la liste, avec en-tête et bouton de dépliage, dont les
notifications forment une pile à éviction par le plus ancien :

```js
addNotification(notification) {
    while (this.notifications.length >= MAX_NOTIFICATIONS_PER_SOURCE) {
        const [oldest] = this.notifications;
        oldest.destroy(NotificationDestroyedReason.EXPIRED);
    }
    ...
    this.notifications.push(notification);
}
```

**Le plafond natif est 10** (`MAX_NOTIFICATIONS_PER_SOURCE`). La taille d'historique
configurable va donc de 1 à 10, et l'éviction est appliquée par l'extension *avant*
`addNotification()` pour que ce soit N qui décide et non 10.

**La Source s'auto-détruit à zéro notification** (`Source._onNotificationDestroy`) :

```js
if (!this._inDestruction && this.notifications.length === 0)
    this.destroy();
```

C'est le piège principal. Si l'utilisateur vide la liste de notifications, la Source
disparaît, et toute référence conservée devient morte. Il faut se connecter à son signal
`destroy`, remettre la référence à `null`, et la recréer paresseusement à la notification
suivante.

**La durée du bandeau n'est pas configurable.** `NOTIFICATION_TIMEOUT = 4000` est une
constante de module, et seul `Urgency.CRITICAL` y échappe
(`_showNotificationCompleted`). C'est accepté : en mode persistent le bandeau garde la
durée native de GNOME. Le réglage de durée ne concerne que le mode toast.

**Conséquence utile pour `withFeedback`** : `_onNotificationRequestBanner` traite le cas où
la notification concernée est déjà celle affichée —

```js
if (this._notification === notification) {
    this._updateShowingNotification();
}
```

Donc une opération qui se termine avant l'expiration du bandeau **mute sur place**, comme
le toast actuel. Une seconde bannière n'apparaît que si l'opération dépasse la fenêtre
d'affichage. Le comportement dégrade proprement selon la durée réelle de l'opération.

---

## 3. Architecture

Les ~36 sites d'appel importent aujourd'hui `ToastManager` et parlent directement au rendu.
On insère une couche de décision.

```
menu.js  ·  extension.js  ·  watchers.js
     │
     │   Notifier.notify({ category, level, message, gicon })
     │   Notifier.withFeedback(category, pending, success, fn)
     ▼
┌─ lib/notify.js ─────────────────────────────┐
│  1. filtre catégorie × niveau  → handle no-op│
│  2. pile de silence ouverte ?  → handle no-op│
│  3. routage selon le mode                    │
└───────┬─────────────────────┬────────────────┘
        │ persistent          │ toast
        ▼                     ▼
  lib/tray.js            lib/toast.js
```

| Module | Responsabilité unique | N'a pas connaissance de |
|---|---|---|
| `lib/notify.js` | politique : catégories, silence, choix du backend | comment on dessine |
| `lib/tray.js` | backend natif : Source, cap N, mise à jour et re-bannière | catégories, GSettings de mode |
| `lib/toast.js` | backend OSD : l'acteur existant réduit à un rendu pur | catégories, mode |
| `lib/watchers.js` | diff de snapshots → évènements sémantiques | comment on notifie |

`lib/notify.js` est le **seul** module que les sites d'appel importent.

### 3.1 Contrat des backends

Les deux backends exposent la même interface, donc `notify.js` ne branche sur le mode qu'à
un seul endroit :

```js
backend.configure(opts)                  // opts propres au backend, poussés par notify.js
backend.show({ message, level, gicon })  →  handle
backend.destroy()

handle.update({ message, level })
handle.dismiss()
```

`level` ∈ `'pending' | 'info' | 'success' | 'warning' | 'error'` — inchangé par rapport à
l'existant.

Le `handle` est la pièce centrale : c'est lui qui porte une opération de l'état « pending »
vers son résultat, et c'est le même objet conceptuel dans les deux modes.

**`notify.js` est le seul module connecté aux GSettings.** Aucun backend ne lit ni n'observe
de clé. `notify.js` s'abonne aux `changed::` et pousse les valeurs par `configure()` :
`{ historySize }` vers `tray.js`, `{ durationMs }` vers `toast.js`. Un backend reste ainsi
une unité de rendu pure, remplaçable et raisonnable isolément.

### 3.3 `withFeedback` remonte dans `notify.js`

`withFeedback` vit aujourd'hui dans `toast.js`. Il devient une méthode de `notify.js`, car il
ne fait que composer des primitives du contrat — `show({level:'pending'})`, attendre, puis
`handle.update()` — et n'a rien de spécifique à un rendu.

C'est aussi lui qui applique le plancher `toast-min-spinner`, dans les deux modes (§4.5), et
qui ouvre l'entrée de silence le temps de l'opération (§8.3).

### 3.2 Le handle no-op

Quand une notification est filtrée (catégorie coupée ou silence en cours), `notify()`
retourne un **handle no-op** — un objet dont `update()` et `dismiss()` ne font rien — et
non `null`.

C'est délibéré. Une quinzaine de sites d'appel font `const t = notify(...)` puis
`t.update(...)` plus tard. Renvoyer `null` obligerait chacun d'eux à tester la nullité, et
un seul oubli produit un `TypeError` dans une callback de main loop — exactement la classe
de défaut qui a valu le deuxième rejet EGO.

---

## 4. Mode persistent — `lib/tray.js`

### 4.1 La Source

Créée paresseusement à la première notification :

```js
new MessageTray.Source({ title: 'Tailscale', icon: <gicon tailscale-symbolic> })
```

`Main.messageTray.add(source)`, puis connexion à `destroy` pour remettre la référence à
`null` (cf. §2). Toute notification ultérieure recrée la Source si besoin.

### 4.2 Éviction

Avant chaque `addNotification()` : tant que `source.notifications.length >= N`, détruire
`source.notifications[0]` avec `NotificationDestroyedReason.EXPIRED`.

N arrive par `configure({ historySize })` (§3.1). Un abaissement de N dans les préférences
déclenche l'élagage immédiat de l'excédent depuis `configure()`, sans attendre la
notification suivante.

### 4.3 Correspondance des niveaux

| `level` | `urgency` | Bandeau |
|---|---|---|
| `pending` | `NORMAL` | oui, titre = message d'attente |
| `info`, `success` | `NORMAL` | oui |
| `warning`, `error` | `HIGH` | oui, passe devant dans la file (`_notificationQueue` est trié par urgence décroissante) |

`CRITICAL` n'est utilisé nulle part : il rend le bandeau collant jusqu'à interaction
manuelle, ce qui est disproportionné pour un changement d'exit node.

### 4.4 Contenu

`title` = le message. `body` reste vide dans le cas général : l'en-tête de groupe affiche
déjà « Tailscale », et les messages existants sont des phrases courtes autosuffisantes
(« Magic DNS: on », « Tailscale connected »). Les erreurs portant un détail du daemon
mettent le libellé court en `title` et le détail en `body`.

### 4.5 `update()` et la re-bannière

```js
notification.title = newMessage;
notification.acknowledged = false;   // redéclenche 'notification-request-banner'
```

Écrire `title` seul ne réaffiche rien : seul le passage de `acknowledged` à `false`
réémet `notification-request-banner` (via le handler branché dans `Source.addNotification`).
Selon que le bandeau est encore affiché ou non, GNOME mute sur place ou en repropose un —
cf. §2.

Le plancher `toast-min-spinner` s'applique **aussi en mode persistent**. Sans lui, une
opération instantanée fait passer le bandeau de « Connecting… » à « Connected » en quelques
dizaines de millisecondes, ce qui est illisible. Le nom de la clé devient légèrement
impropre en mode persistent (il n'y a pas de spinner) ; c'est accepté pour ne pas casser
les préférences existantes.

---

## 5. Mode toast — `lib/toast.js`

Comportement inchangé, y compris `toast-duration` et le spinner `Animation.Spinner`.

Le module est **réduit à un backend de rendu** : il perd `hasActiveOp` et la connaissance
des GSettings, qui remontent dans `notify.js`. Il conserve l'acteur `Toast`, le conteneur,
le repositionnement et la gestion de cycle de vie des timeouts, qui sont corrects.

---

## 6. Schéma GSettings

```xml
<enum id="org.gnome.shell.extensions.tailscale-gnome.notification-mode">
  <value nick="persistent" value="0"/>
  <value nick="toast"      value="1"/>
</enum>
```

| Clé | Type | Plage | Défaut |
|---|---|---|---|
| `notification-mode` | enum | persistent / toast | `persistent` |
| `notification-history-size` | `u` | 1–10 | 5 |
| `toast-duration` | `u` | 1–10 s | 3 (existant) |
| `toast-min-spinner` | `u` | 0–3000 ms | 1000 (existant) |
| `notify-connection` | `b` | | `true` |
| `notify-account` | `b` | | `true` |
| `notify-profile-switch` | `b` | | `true` |
| `notify-exit-node` | `b` | | `true` |
| `notify-network` | `b` | | `true` |
| `notify-taildrop` | `b` | | `true` |
| `notify-funnel` | `b` | | `true` |
| `notify-errors` | `b` | | `true` |
| `notify-misc` | `b` | | `true` |

---

## 7. Filtrage : catégorie × niveau

Chaque notification porte **une catégorie** (son domaine) et **un niveau**. Les deux axes
sont indépendants.

> Une notification est affichée si **sa catégorie est active**, **ou** si **son niveau est
> `warning`/`error` et que `notify-errors` est actif.**

`notify-errors` n'est donc pas une neuvième catégorie mais un **filet de sécurité** :
couper « Taildrop » fait taire les « Sent to laptop » sans rendre les échecs d'envoi
silencieux. Les erreurs sans domaine — signal `error` du daemon, échec d'ouverture d'URL,
portail de fichiers indisponible — portent la catégorie `errors` et ne dépendent que de
cet interrupteur.

Conséquence à ne pas perdre de vue : décocher les huit catégories de domaine ne suffit pas
à obtenir le silence complet, il faut aussi décocher `notify-errors`. C'est le comportement
voulu.

### 7.1 Correspondance des sites d'appel

| Catégorie | Sites |
|---|---|
| `connection` | up/down (`menu:948,954` · `ext:465,471`), garde-fous « Login required » / « not ready » (`menu:928,940` · `ext:457,461`), `_maybeToastConnection` |
| `account` | login (`menu:1610`), logout (`menu:1626`), operator (`menu:897`, plus le `notify-info` du daemon) |
| `profile-switch` | changement de compte (`menu:1578`), « Profile preferences applied » (`ext:94`) |
| `exit-node` | sélection / effacement / routage (`menu:1412,1423,1461` · `ext:482,488`), accès LAN (`menu:1479`), `_maybeToastExitNodeChange` |
| `network` | Magic DNS / routes / shields / SSH (`menu:737,747,761,770`), bascules du panneau Features (`ext:277,286,311,346`) |
| `taildrop` | récepteur on/off (`menu:1675`), envoi (`menu:1719`), admin-disabled et absence de pairs (`menu:1696,1704`) |
| `funnel` | ajout / suppression (`menu:1221,1267`), ports saturés, port invalide, approbation navigateur (`menu:1238,1256,1285,1290`) |
| `errors` | signal `error` du daemon (`menu:618`), ouverture d'URL (`menu:64`), portail de fichiers (`menu:1804`) |
| `misc` | rafraîchissement manuel (`menu:662`), copie presse-papier (`menu:1844`) |

Les numéros de ligne réfèrent à `ff1d842` et servent de repères de départ, pas de cible
figée.

---

## 8. Fenêtre de silence

### 8.1 Le problème

Un changement de compte produit aujourd'hui une rafale de notifications. Le garde-fou
existant (`PerAccountFeatureState.isLoadingSlot`) ne couvre que les notifications déclenchées
par les signaux `changed::feature-*`. Passent à travers :

| Source | Ce qui sort |
|---|---|
| le `withFeedback` du switch lui-même | « Switching to X » → « Active account: X » |
| `_onSlotLoaded` → `refresh()` → `ensureFeatureCompliance` (`ext:235`) | écritures daemon → signaux `notify-info`/`error` → `spontaneous()` (`menu:618`) |
| `_maybeToastExitNodeChange` (`menu:977`) | le nouveau tailnet a un autre exit node → « went offline », « Auto exit node: … » |
| `_maybeToastConnection` (`menu:1024`) | le `backendState` oscille pendant la bascule |
| `probeAvailability()` (`ext:128`) | écritures des clés `feature-*-available` |
| le callback `_onSlotLoaded` | « Profile preferences applied » |

### 8.2 La solution

`notify.js` porte une **pile de silence** : `beginQuiet({ scope, reason })` / `endQuiet(token)`.
Deux portées, et la distinction n'est pas cosmétique — les confondre changerait le
comportement actuel.

| Portée | Ouverte par | Fait taire |
|---|---|---|
| `spontaneous` | `withFeedback`, le temps de son opération | uniquement les notifications marquées `spontaneous: true` |
| `all` | le changement de compte | tout, sauf `force: true` |

Les notifications `spontaneous` sont celles que personne n'a demandées : évènements de
`watchers.js` et signaux `error` / `notify-info` du daemon. Les retours d'action utilisateur
ne le sont pas et traversent une fenêtre `spontaneous` — c'est déjà le comportement actuel
(seuls `menu:617,977,1032` consultent `hasActiveOp`, jamais les `withFeedback`), et le
perdre rendrait muette la seconde de deux actions rapprochées.

**`force: true` ne contourne que le silence, jamais le filtre de catégorie (§7).** Si
l'utilisateur a décoché `notify-profile-switch`, la notification « Profil appliqué » ne
sort pas. Un interrupteur qui ne coupe pas serait un mensonge d'interface.

Le changement de compte ouvre la fenêtre au début de `switchAccount` et la referme quand le
snapshot se stabilise : fermeture débouncée deux intervalles de poll après le dernier
`state-changed` porteur d'un changement, avec **un plafond dur** au-delà duquel la fenêtre
se referme quoi qu'il arrive. Une seule notification sort, marquée `force`, avec la
catégorie `profile-switch` :

> **Profil appliqué — `<nom du tailnet>`**

Le plafond dur n'est pas une précaution de style : une fenêtre de silence qui reste ouverte
rend l'extension définitivement muette, ce qui est un échec silencieux du même genre que
celui qui a motivé le deuxième rejet EGO. Le timeout est enregistré et retiré dans
`destroy()`, et la source est mise à `0` avant tout ré-armement — la leçon `clear-before-rearm`
du correctif Taildrop de la v0.2.1.

### 8.3 Unification avec `hasActiveOp`

`ToastManager.hasActiveOp` exprime la même idée à une autre échelle : « une opération plus
grosse est en cours, tais-toi ». Il devient une fenêtre de portée `spontaneous`, ouverte par
`withFeedback` pour la durée de son opération.

Les cinq vérifications éparpillées disparaissent des sites d'appel, remplacées par le
marquage `spontaneous: true` à l'émission :

| Aujourd'hui | Devient |
|---|---|
| `menu:617` `spontaneous()` teste `hasActiveOp` | helper supprimé, les signaux daemon sont émis `spontaneous: true` |
| `menu:977` `_maybeToastExitNodeChange` teste `hasActiveOp` | évènement de `watchers.js`, émis `spontaneous: true` |
| `menu:1032` `_maybeToastConnection` teste `hasActiveOp` | idem |
| `ext:269` `handleFeatureToggled` teste `isLoadingSlot` | couvert par la fenêtre `all` du changement de compte |
| `ext:344` bascule Taildrop/Funnel teste `isLoadingSlot` | idem |

`PerAccountFeatureState.isLoadingSlot` n'a alors plus de consommateur. La propriété et le
drapeau `_suppressSave` qui la porte restent en place pour cette spec — `_suppressSave` sert
aussi à empêcher la réécriture en boucle du slot pendant le chargement, et
`per-account.js` disparaît de toute façon en spec n°2. La retirer ici serait un changement
sans bénéfice dans un fichier condamné.

---

## 9. `lib/watchers.js`

`_maybeToastConnection` et `_maybeToastExitNodeChange` totalisent ~110 lignes dans un
`menu.js` qui en fait 1850. Elles ne rendent rien : elles comparent le snapshot précédent au
nouveau pour en déduire des évènements. C'est de la logique de veille, pas de la logique de
menu.

Elles sortent dans `lib/watchers.js` sous la forme d'une unité qui reçoit les snapshots
successifs et émet des évènements sémantiques :

```
connection-starting · connection-established · connection-ended
exit-node-lost · exit-node-acquired · exit-node-switched
exit-node-offline · exit-node-online · exit-node-disabled · exit-node-reenabled
```

`extension.js` câble ces évènements sur `Notifier`. Le suivi d'état (`_exitTrack`,
`_lastBackendState`, `_connToast`) déménage avec elles.

Bénéfice concret : le calcul devient une fonction de deux snapshots, donc vérifiable en
isolation sans faire tourner une session GNOME, et `menu.js` cesse de porter du code de
notification.

La règle « un nœud ne compte comme effectif que s'il est à la fois en ligne et toujours
annoncé comme sortie » (commentaire de `_maybeToastExitNodeChange`) est conservée
telle quelle : elle corrige un cas réel où le daemon laisse `ExitNode: true` sur un nœud
tombé.

---

## 10. Simplifications et suppression de code mort

Travail explicite de la spec, pas effet de bord.

1. **Deux mécanismes de suppression → un.** `hasActiveOp` devient une fenêtre `spontaneous`,
   `isLoadingSlot` est supplanté par la fenêtre `all` du changement de compte. Les cinq
   vérifications disparaissent des sites d'appel, remplacées par un marquage à l'émission
   (§8.3).
2. **`menu.js` allégé de ~110 lignes** par l'extraction vers `watchers.js` (§9).
3. **`spontaneous()` (`menu:617`) supprimé** — sa seule raison d'être est la vérification
   `hasActiveOp` que `notify.js` fait désormais lui-même.
4. **`toast.js` réduit à un backend** — perd `hasActiveOp` et sa connexion aux GSettings.
5. **Balayage final en trois vérifications croisées :**
   - chaque `export` confronté aux imports du dépôt ;
   - chaque `<key name=>` du gschema confrontée aux `get_*` / `bind` du JS ;
   - chaque classe de `stylesheet.css` confrontée aux `style_class` du JS.

---

## 11. Vérification

Aucun harnais de test unitaire n'existe dans le dépôt, et une extension GNOME Shell ne se
teste pas hors session. La vérification est donc :

**Automatique**
```
make test-syntax
make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip
```
Référence à ne pas dégrader, mesurée sur `ff1d842` : **0 erreur, 0 warning**, un seul
`manual_review` (accès presse-papier, déjà déclaré dans `metadata.json`).

**Manuelle, en session imbriquée** (`dbus-run-session -- gnome-shell --devkit`)

| # | Scénario | Attendu |
|---|---|---|
| 1 | mode persistent, connect/disconnect | une entrée sous « Tailscale » dans la liste ; bandeau natif |
| 2 | opération rapide (Magic DNS) | un seul bandeau, muté sur place |
| 3 | opération lente (`up` sur réseau dégradé) | bandeau « Connecting… », puis second bandeau au résultat |
| 4 | N = 3, déclencher 5 évènements | trois entrées, les deux plus anciennes évincées |
| 5 | vider la liste puis notifier | la Source est recréée, la notification apparaît |
| 6 | abaisser N pendant que l'historique est plein | élagage immédiat |
| 7 | basculer en mode toast | comportement v0.2.1, `toast-duration` respecté |
| 8 | couper `notify-taildrop`, envoyer un fichier | pas de notification de succès |
| 9 | idem, provoquer un échec d'envoi | l'échec passe quand même (`notify-errors`) |
| 10 | couper les 9 interrupteurs | silence total |
| 11 | deux actions utilisateur rapprochées (DNS puis routes) | **deux** retours, aucun avalé — la fenêtre `spontaneous` ne filtre pas les actions |
| 12 | exit node tombe pendant une opération utilisateur | l'alerte spontanée est avalée, pas de doublon |
| 13 | changer de compte | **une seule** notification « Profil appliqué » |
| 14 | couper `notify-profile-switch`, changer de compte | silence complet — `force` ne contourne pas la catégorie |
| 15 | changer de compte, daemon lent | le plafond dur referme la fenêtre, les notifications reprennent |
| 16 | désactiver l'extension pendant une opération en attente | aucun timeout ni source résiduels |
| 17 | verrouiller la session avec des notifications en historique | pas de fuite d'information en écran de veille |

Le point 16 est celui à ne pas bâcler : c'est la classe de défaut des deux rejets EGO.

---

## 12. Hors périmètre

**Spec n°2 — simplification de l'état par compte.** `tailscale debug prefs` confirme que
tailscaled persiste déjà, *par profil*, tout ce que le panneau Features contrôle :
`RouteAll`, `ExitNodeID`, `ExitNodeIP`, `CorpDNS`, `RunSSH`, `ShieldsUp`,
`ExitNodeAllowLANAccess`, `WantRunning`. L'état par compte de l'extension duplique donc un
mécanisme que tailscale assure mieux.

Décisions déjà prises pour cette spec, à ne pas re-débattre :

- couper une feature masque l'UI **et** réinitialise l'état daemon correspondant, en une
  seule fois au moment du clic ;
- la réactiver ne restaure rien — l'UI affiche ce que tailscale a à cet instant ;
- pas de correction de dérive continue : une commande CLI passée derrière l'extension n'est
  pas annulée, `ensureFeatureCompliance` disparaît ;
- `per-account.js`, les cinq clés `feature-*-saved` et `feature-state-per-account`
  disparaissent ; les sept booléens de visibilité restants deviennent globaux.

La persistance au redémarrage et la bascule de profil sont alors assurées par tailscaled
sans code d'extension.

**Abandonné.** La fenêtre read-only des profils envisagée en cours de conception perd son
objet une fois l'état par compte supprimé : il ne resterait à afficher que la sortie de
`tailscale switch --list`, déjà présente dans le menu Account.

**Non retenu.** Rendre la durée du bandeau natif configurable en surchargeant
`MessageTray._showNotificationCompleted` : correction d'un interne du Shell, risque de rejet
disproportionné au gain pour une troisième soumission EGO.
