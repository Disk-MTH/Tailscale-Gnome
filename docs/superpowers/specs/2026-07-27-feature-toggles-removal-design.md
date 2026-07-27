# Suppression des interrupteurs de features

**Date** : 2026-07-27
**Statut** : validé, prêt pour le plan d'implémentation
**Périmètre** : `extension.js`, `lib/menu.js`, `prefs.js`, le schéma GSettings, `README.md`, `CHANGELOG.md`.
**Suite de** : `2026-07-27-per-account-removal-design.md` (spec n°2), dont elle supprime une partie du travail.

Ce document est rédigé en français parce qu'il sert de support de relecture. Tout ce qui est
livré (code, commentaires, chaînes traduisibles, README) reste en anglais.

---

## 1. Objectif

Le panneau Features permet de masquer sept blocs du menu Quick Settings. À l'usage, ça ne
sert à rien : personne ne cache le sous-menu Exit node d'un client Tailscale.

Ce non-usage se paie cher. Chaque interrupteur devait décider quoi faire de l'état daemon
correspondant, ce qui a produit successivement : des clés de sauvegarde par feature, une
correction de dérive continue, une persistance par compte, puis — après la spec n°2 — un
reset unique au clic avec sa branche « daemon injoignable ». Trois conceptions pour une
fonctionnalité que l'utilisateur n'utilise pas.

On supprime les interrupteurs. Le gain n'est pas de retirer sept cases : c'est que
**l'extension cesse définitivement d'écrire dans le daemon sans qu'on le lui demande**.
Après ce changement, toute écriture daemon vient d'une action explicite sur le menu.

Ce qui reste, parce que ce n'est pas un choix de l'utilisateur mais un fait du tailnet :
Taildrop et Funnel peuvent être interdits par l'administrateur. Cette détection est
conservée entière — sonde, bouton de vérification, lien vers la console d'admin, texte
d'explication — mais elle cesse d'être présentée comme un réglage. Un interrupteur invite à
agir ; l'utilisateur ne peut rien pour une ACL. Elle devient un **état affiché** : ✓ ou ✗.

---

## 2. Ce qui disparaît

| Élément | Emplacement |
|---|---|
| les 7 clés `feature-*` | gschema `:73-106` |
| `FEATURE_META` et son commentaire d'intro | `ext:265-320` |
| `handleFeatureToggled` et son `connectObject` | `ext:322-370` |
| le gating des 5 lignes réseau | `menu:1571-1575` |
| 7 des 9 clés de `renderKeys` | `menu:596-607` |
| les 5 entrées réseau de `FEATURE_DEFS` | `prefs:531-535` |
| la branche sans `availabilityKey` de `_makeFeatureRow` | `prefs:609-614` |
| le `Gtk.Switch`, son `guard`, son handler et le bouton reset de la ligne | `prefs:631-634`, `:671-702` |

Ce bloc emporte avec lui la dernière écriture daemon non sollicitée de l'extension :
`Notifier.withFeedback(…, () => meta.reset(this._client))`. Les setters qui subsistent dans
`extension.js` répondent tous à une demande explicite — `setOperator()` derrière son invite
polkit, `setExitNode()` derrière un raccourci clavier, `setAcceptFiles()` derrière la case
« accepter les fichiers ». Aucun setter d'état démon ne part d'un `changed::` que
l'utilisateur n'a pas provoqué.

**Conséquence assumée** : masquer Funnel ne démonte plus les funnels actifs. Ce n'était pas
un service rendu mais un effet de bord destructeur — un tailnet dont l'utilisateur n'avait
jamais coché Funnel voyait ses funnels réinitialisés à chaque snapshot par
`ensureFeatureCompliance`, avant la spec n°2. Le menu Funnel garde son bouton de suppression
pour qui veut démonter un funnel.

---

## 3. Ce qui reste

Les deux clés `feature-taildrop-available` et `feature-funnels-available` gardent leur nom,
leur type et leur défaut à `false` (« présumer interdit »). Leur préfixe `feature-` devient
un peu impropre puisqu'il n'y a plus de features ; le renommage est écarté au §7.

Restent inchangés : `TailscaleClient.probeAvailability()`, la sonde ponctuelle du démarrage
(`ext:200-206`), la re-sonde sur `account-switched` (`ext:163`), la re-sonde de « Reset all »
(`prefs:1084-1091`), les boutons de vérification par ligne, le bouton **Open admin**, le
bouton ⓘ et son lien vers la documentation.

---

## 4. Le panneau devient un panneau d'état

### 4.1 Forme

```
Availability
What this tailnet allows. Both depend on your tailnet's admin settings.

ⓘ  Taildrop                              ✓   [⟳]
ⓘ  Funnel                                ✗   [⟳] [Open admin]
   Funnel is not enabled for this tailnet.
```

Le groupe est renommé `Features` → `Availability`, et sa description passe de « Enable or
disable specific Tailscale features. Disabled features are hidden from the Quick Settings
menu. » — qui décrit un réglage qui n'existe plus — à l'énoncé d'un fait.

Chaque ligne perd son `Gtk.Switch` et son bouton reset ; elle gagne une icône d'état à leur
place. La ligne n'est plus activable : `set_activatable_widget()` disparaît avec
l'interrupteur.

### 4.2 L'icône

```js
new Gtk.Image({
    icon_name: available ? 'emblem-ok-symbolic' : 'window-close-symbolic',
    css_classes: [available ? 'success' : 'error'],
    valign: Gtk.Align.CENTER,
});
```

`success` et `error` sont des classes libadwaita standard ; elles teintent l'icône en vert et
en rouge en suivant le thème clair/sombre de l'utilisateur, ce qu'une couleur codée en dur ne
ferait pas. L'icône porte un `tooltip_text` — « Available on this tailnet » / « Not available
on this tailnet » — parce qu'une icône seule n'est pas lisible par un lecteur d'écran.

Le sous-titre d'indisponibilité (`unavailableHint`) et la visibilité conditionnelle du bouton
**Open admin** sont conservés tels quels : ils portent le *pourquoi*, que l'icône ne dit pas.

### 4.3 Sonde à l'ouverture

`fillPreferencesWindow` lance les deux vérificateurs en tâche de fond et écrit les deux clés.
Un état affiché doit être frais sans qu'on ait à cliquer ; le bouton par ligne devient un
rafraîchissement manuel plutôt que la source principale.

La sonde est asynchrone et sans attente : la fenêtre s'ouvre immédiatement sur la dernière
valeur connue et l'icône se met à jour quand la réponse arrive, par le `changed::` auquel la
ligne est déjà abonnée. Un échec est silencieux — c'est déjà le comportement de la sonde du
démarrage et de celle de « Reset all ».

---

## 5. Le menu

`_applyFeatureGates` perd sa moitié réseau. Les cinq lignes — exit node, Magic DNS, routes,
shields, SSH — sont désormais toujours visibles, et leur visibilité redevient ce que le
rendu principal en dit.

Sa moitié ACL est conservée à l'identique, la conjonction en moins :

```js
const taildrop = s.get_boolean('feature-taildrop-available');
const funnels  = s.get_boolean('feature-funnels-available');
```

La règle reste **masquer** ce qui n'est pas utilisable, pas l'afficher grisé : un menu ne
montre que l'actionnable, et le pourquoi se lit dans les préférences.

Le nom `_applyFeatureGates` reste correct — il en reste deux.

`renderKeys` (`menu:596-607`) tombe de dix à trois : `taildrop-accept` et les deux clés
`-available`. Le commentaire au-dessus, qui mentionne « a feature toggle flips in the prefs
Features panel », est réécrit.

---

## 6. Le receveur Taildrop

`syncTaildrop` (`ext:220-247`) conditionne aujourd'hui le sous-processus
`tailscale file get --loop` à `feature-taildrop && taildrop-accept`. La sonde prend la place
du toggle :

```js
const availableOn = this._settings.get_boolean('feature-taildrop-available');
const acceptOn    = this._settings.get_boolean('taildrop-accept');
this._client.setAcceptFiles(availableOn && acceptOn, inbox);
```

Faire tourner un receveur sur un tailnet qui refuse Taildrop ne recevra jamais rien. Les deux
autres sites suivent : l'abonnement `changed::feature-taildrop` devient
`changed::feature-taildrop-available`, et le rebond sur changement d'inbox lit la même paire.

La sensibilité du groupe Taildrop dans les préférences (`prefs:183-200`) perd de même sa
moitié toggle et ne dépend plus que de la disponibilité. Son commentaire, qui parle de
« mirror the feature switch », est réécrit.

---

## 7. Hors périmètre

**Renommer les deux clés `-available`.** Leur préfixe `feature-` n'a plus de référent, mais
un renommage de clé GSettings est un changement cassant pour un gain cosmétique : les valeurs
existantes seraient perdues et l'extension repartirait sur « présumer interdit » jusqu'à la
première sonde. Le coût dépasse le bénéfice.

**Nettoyer les 7 clés retirées dans dconf.** Même raisonnement qu'en spec n°2 §8 : on ne peut
pas `reset()` une clé absente du schéma, et écrire dans dconf à la main pour effacer des
valeurs que plus rien ne lit serait du risque gratuit.

**Afficher l'état de disponibilité dans le menu.** Le menu communique déjà par présence ou
absence. Y ajouter une ligne « Funnel ✗ » ferait grandir le menu pour dire non.

---

## 8. Migration

Les 7 clés `feature-*` restent inertes dans dconf. Ce que l'utilisateur constate au premier
lancement, c'est que les blocs qu'il avait masqués sont revenus dans le menu — y compris
Taildrop et Funnel, dont l'affichage ne dépend plus que de ce que le tailnet autorise.

Aucun état daemon n'est touché par la mise à jour elle-même. Un utilisateur qui avait
décoché « Magic DNS » a vu `CorpDNS` passer à `false` au moment de ce clic ; la valeur reste
`false` après la mise à jour, et la ligne réapparaît dans le menu en l'affichant
correctement. Rien à annuler, rien à restaurer.

À noter au CHANGELOG comme un retrait de fonctionnalité, pas comme un correctif.

---

## 9. Vérification

**Automatique**

```
make test
make test-syntax
make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip
```

Aucun test unitaire n'est ajouté : rien de ce qui change n'est une règle pure. `menu.js`,
`prefs.js` et le câblage d'`extension.js` demandent une session GNOME. La suite reste à 37
tests, inchangée.

Le balayage de fin de spec n°2 est rejoué, et l'un de ses volets devient un contrôle exact :
chaque `<key name=>` du gschema doit avoir un lecteur en JS.

**Manuelle, en session imbriquée** (`dbus-run-session -- gnome-shell --devkit`)

| # | Scénario | Attendu |
|---|---|---|
| 1 | ouvrir le menu | exit node, Magic DNS, routes, shields, SSH tous présents, sans condition |
| 2 | tailnet autorisant Taildrop et Funnel | les deux blocs présents |
| 3 | tailnet refusant Funnel | le bloc Funnel absent, le séparateur non orphelin |
| 4 | ouvrir les préférences | les deux lignes affichent ✓ ou ✗ ; la sonde tourne seule, sans clic |
| 5 | ligne indisponible | croix rouge, sous-titre explicatif, bouton **Open admin** visible |
| 6 | ligne disponible | coche verte, pas de bouton **Open admin**, pas de sous-titre |
| 7 | cliquer le bouton de vérification | l'icône se met à jour, un toast confirme |
| 8 | cocher « Accepter les fichiers » sur un tailnet autorisant Taildrop | le receveur démarre |
| 9 | même chose, tailnet refusant Taildrop | le bloc n'est pas dans le menu, donc rien à cocher |
| 10 | basculer de compte vers un tailnet aux ACL différentes | les blocs du menu suivent la nouvelle disponibilité |
| 11 | « Reset all » dans les préférences | les deux lignes se re-sondent, les icônes se mettent à jour |
| 12 | désactiver l'extension | aucun timeout ni source résiduels |
| 13 | thème clair puis thème sombre | la coche et la croix restent lisibles dans les deux |

Le point 12 reste celui à ne pas bâcler : c'est la classe de défaut des deux rejets EGO.

**Documentation** — `README.md:32-33` (« Prefs toggles for Magic DNS, Accept routes, Shields
up, SSH server, Allow LAN access ») décrit les lignes du menu et non le panneau Features,
mais la formulation « Prefs toggles » devient trompeuse ; le tableau des réglages
(`README.md:110-131`) liste trois lignes « Features » qui n'existent plus.
