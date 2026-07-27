# Suppression de l'état par compte

**Date** : 2026-07-27
**Statut** : validé, prêt pour le plan d'implémentation
**Périmètre** : `lib/per-account.js` (supprimé), `lib/watchers.js`, `extension.js`, le schéma GSettings, `README.md`.
**Suite de** : `2026-07-26-notifications-design.md` (spec n°1), dont elle amende les §8.2 et §8.3.

Ce document est rédigé en français parce qu'il sert de support de relecture. Tout ce qui est
livré (code, commentaires, chaînes traduisibles, README) reste en anglais.

---

## 1. Objectif

L'extension tient un dictionnaire JSON d'états par tailnet, sauvé et rechargé à chaque
changement de compte. L'intention était : « mémoriser comment était le compte A pour le
restaurer quand on y revient ».

Cette mémoire est redondante. `tailscaled` persiste déjà ces préférences par profil, et les
restaure lui-même à `tailscale switch`. L'extension duplique donc un mécanisme du daemon —
et, pire, le contredit (§3.3).

On supprime la duplication. Ce qui reste de la bascule de compte est un évènement, pas un
état.

---

## 2. Faits vérifiés

Relevés sur la machine de développement le 2026-07-27, deux profils actifs.

`tailscale switch --list` :

```
ID    Tailnet               Account
0a78  gillet.fra@gmail.com  gillet.mat@free.fr*
70ac  gillet.mat@free.fr    gillet.mat@free.fr
```

`tailscale debug prefs` retourne le bloc de préférences **du profil actif** :

```json
{
  "RouteAll": true,
  "ExitNodeID": "",
  "ExitNodeIP": "",
  "ExitNodeAllowLANAccess": false,
  "CorpDNS": true,
  "RunSSH": false,
  "WantRunning": true,
  "ShieldsUp": false,
  "OperatorUser": "diskmth"
}
```

Ces huit champs sont exactement ce que le panneau Features pilote. Ils vivent dans le
profil, pas dans un état global : basculer de profil les recharge, sans intervention de
l'extension.

**Conséquence** : la restauration par compte que l'extension croit assurer est déjà assurée
en amont, et mieux — le daemon connaît son propre état, l'extension n'en a qu'une copie
datée du dernier snapshot.

---

## 3. Ce que l'extension mémorise, et pourquoi c'est faux

`PerAccountFeatureState` sauve 14 clés par tailnet (`per-account.js:14-29`). Elles ne sont
pas de même nature, et les confondre est l'erreur d'origine.

### 3.1 Les trois natures

| Nature | Clés | Qui doit la porter |
|---|---|---|
| **A — affichage** : « montre le sous-menu Exit node » | les 7 `feature-*` | l'extension, personne d'autre |
| **B — sauvegarde d'état daemon** : « avant que tu coupes Magic DNS, CorpDNS était à `on` » | les 5 `feature-*-saved` | le daemon, qui le fait déjà |
| **C — cache d'ACL** : « ce tailnet a droit à Funnel » | les 2 `feature-*-available` | un cache, qui se re-sonde |

### 3.2 Les clés `-saved` ne servent pas à la bascule

C'est le point le plus contre-intuitif. Les 5 clés `feature-*-saved` ne sont jamais lues
lors d'un changement de compte. Leur unique usage (`ext:423-436`) est un annuler/refaire
local :

> décocher « Magic DNS » dans les prefs → `CorpDNS` passe à `false`, l'ancienne valeur est
> notée → recocher → l'ancienne valeur est réappliquée.

C'est un undo à l'échelle d'un clic, pas une restauration de profil. Le fait qu'il soit
stocké par tailnet est un effet de bord du slot, pas une intention.

### 3.3 Les deux mémoires se contredisent

`ensureFeatureCompliance` (`ext:366-383`) tourne à chaque snapshot et force le daemon à
obéir aux toggles d'affichage de l'extension. Enchaînement observable :

1. `tailscale switch` → le daemon restaure les prefs du profil B, dont `CorpDNS: true` ;
2. `PerAccountFeatureState` applique le slot de B, dont `feature-dns: false` ;
3. `ensureFeatureCompliance` voit « feature off, daemon on » et écrit `CorpDNS: false`.

L'extension écrase la préférence que le daemon venait de restaurer, avec une valeur qui
vient de sa propre copie. La duplication ne coûte pas que des lignes : elle produit des
conflits.

### 3.4 Ce qu'on renonce, exactement

Deux choses, décidées et à ne pas re-débattre :

1. **Les 7 toggles d'affichage deviennent globaux.** Cacher le sous-menu Funnel sur le
   compte perso et pas sur le pro n'est plus possible.
2. **Recocher une feature ne restaure plus rien.** Le sous-menu réapparaît en affichant ce
   que le daemon a à cet instant ; c'est à l'utilisateur de rallumer ce qu'il veut.

---

## 4. Ce qui disparaît

| Élément | Emplacement |
|---|---|
| `lib/per-account.js` (167 lignes) | + son import `ext:17`, sa construction `ext:187-229`, son `destroy()` `ext:542-543` |
| clé `feature-state-per-account` | gschema `:149-158` |
| les 5 clés `feature-*-saved` | gschema `:108-130` |
| le champ `savedKey` de `FEATURE_META` | `ext:328,335,342,349,356` |
| la branche de restauration au réenclenchement | `ext:423-436` |
| `ensureFeatureCompliance` et son abonnement `state-changed` | `ext:366-388` |
| `isLoadingSlot` / `_suppressSave` et les deux gardes qu'ils imposent | `ext:400`, `ext:480` |
| le tracker `_lastAccountName` et son abonnement | `ext:250-263` |
| l'appel `client.refresh()` de `onSlotLoaded` | `ext:226` — n'existait que pour laisser `ensureFeatureCompliance` réconcilier |
| `QuietScope` en entier et le paramètre `force` | `notify-policy.js:43-46,104-113`, `notify.js:17,126,197,233`, `ext:15,193,219` — voir §6.4 |

`FEATURE_META` conserve `label`, `type`, `snapKey` et `set` : le reset au clic a toujours
besoin de savoir quoi lire dans le snapshot et quoi appeler sur le client.

---

## 5. Ce qui reste

**Les 7 `feature-*`** deviennent des préférences globales. Aucun changement de schéma : ce
sont déjà des clés globales, simplement plus personne ne les réécrit dans le dos de
l'utilisateur.

**Les 2 `feature-*-available`** restent un cache global, re-sondé à chaque bascule (§6).
Entre la bascule et le retour de la sonde, la valeur du tailnet précédent reste affichée
brièvement — c'est déjà le cas aujourd'hui, la sonde étant asynchrone dans les deux
conceptions. La sonde ponctuelle du démarrage (`ext:244-249`) est conservée telle quelle ;
c'est seulement la re-sonde sur bascule qui change de déclencheur.

**`syncTaildrop`** (`ext:270-292`) est inchangé : il coupe déjà le receveur quand
`feature-taildrop` passe à `false`.

**La mécanique de fenêtre de silence** (`ext:153-185` : `closeQuiet`, `armQuietDebounce`,
le plafond dur de 30 s) est conservée telle quelle. Seul son déclencheur change.

---

## 6. La bascule de compte devient un évènement

### 6.1 `watchers.js` émet `account-switched`

`accountName` est un champ du snapshot comme un autre. Le détecter appartient donc au module
dont c'est la responsabilité unique — traduire un diff de snapshots en évènements
sémantiques — et non à `extension.js`.

`EMPTY_TRACK` gagne `accountName: null`. Une fonction `_accountEvents(track, snap, out)`
émet au plus un évènement :

```js
if (!track.seeded) return;                 // muet au démarrage à froid
if (!snap.accountName) return;             // pas de tailnet connu (déconnecté)
if (snap.accountName === track.accountName) return;
out.push({
    type: 'account-switched',
    category: Category.PROFILE_SWITCH,
    level: 'success',
    spontaneous: false,
    data: { name: snap.accountName },
});
```

`_accountEvents` est appelée **en premier** dans `computeEvents`, avant les évènements de
connexion et d'exit node. L'ordre est significatif : `extension.js` ouvre la fenêtre de
silence en traitant `account-switched`, donc tout ce qui suit dans le même lot est déjà
couvert.

`_event()` déduit aujourd'hui la catégorie du préfixe du type et impose
`spontaneous: true`. Elle doit accepter ces deux valeurs en paramètre. L'évènement de
bascule n'est pas spontané : c'est le compte rendu d'une action, pas un bruit de fond.

### 6.2 `extension.js` réagit

La boucle d'évènements (`ext:107-133`) code en dur `spontaneous: true` pour chaque
notification émise. Elle doit propager `ev.spontaneous`, sans quoi `account-switched`
s'auto-censure.

`WATCHER_COPY` (`ext:88-101`) gagne son entrée, seul endroit où le type devient du texte
traduisible — `watchers.js` ne porte aucune chaîne (c'est ce qui garde `gettext` hors du
fichier et le rend testable) :

```js
'account-switched': (d) => _fmt(_('Profile applied (%s)'), d.name),
```

`account-switched` demande une branche dédiée dans la boucle, comme
`connection-starting` en a déjà une — parce qu'il déclenche des effets et porte une garde,
là où les autres évènements se contentent d'être notifiés :

```js
if (ev.type === 'account-switched') {
    openQuietWindow();                          // §6.3
    this._client.probeAvailability().catch(() => {});
    if (Notifier.isCategoryBusy(Category.PROFILE_SWITCH))
        continue;                               // le withFeedback du menu rapporte déjà
}
```

La garde `isCategoryBusy` est reprise telle quelle de `onSlotLoaded` (`ext:215`). Elle évite
le doublon quand la bascule vient du menu, dont le `withFeedback` rapporte le résultat
lui-même. Une bascule externe (`tailscale switch` en ligne de commande) n'a pas de
`withFeedback` : la notification est alors le seul compte rendu, et doit sortir.

L'ouverture de la fenêtre et la sonde restent inconditionnelles — le bruit de daemon suit la
bascule qu'elle vienne du menu ou non.

### 6.3 La portée passe de `ALL` à `SPONTANEOUS`

La spec n°1 §8.2 ouvrait une fenêtre `ALL` parce que la bascule produisait une rafale
d'écritures `feature-*` et les notifications de `handleFeatureToggled` qui allaient avec.
Cette rafale disparaît avec le slot. Ce qui reste à taire pendant une bascule est
exclusivement du bruit de daemon — transitions d'exit node, oscillation de `backendState` —
tout marqué `spontaneous: true`.

Conséquences :

- « Profile applied » n'a plus besoin de `force: true` ;
- une action utilisateur lancée pendant la bascule redevient audible. C'est la lecture
  correcte : l'utilisateur qui clique attend un retour, la bascule ne le concerne pas.

Le plafond dur de 30 s reste indispensable pour la même raison qu'en spec n°1 : une fenêtre
qui ne se referme jamais rend l'extension définitivement muette. Sources effacées avant tout
ré-armement, retirées dans `disable()`.

### 6.4 `QuietScope` s'effondre, `force` disparaît

`ext:193` était le seul appelant de `QuietScope.ALL`. La portée n'ayant plus qu'une valeur,
le concept lui-même n'a plus d'objet.

Et `force` avec lui. Son rôle était de percer une fenêtre `ALL` ; sous une fenêtre
`spontaneous`, une notification non spontanée passe déjà par construction. Ses trois usages
— le `pending` et le résultat de `withFeedback` (`notify.js:197,233`), et « Profile
applied » (`ext:219`) — sont tous non spontanés. `spontaneous: false` **est** l'échappatoire.

```js
// notify-policy.js
- export const QuietScope = Object.freeze({ SPONTANEOUS, ALL });
- this._quiet = new Map();          // token -> QuietScope
+ this._quiet = new Set();          // tokens ouverts

- shouldShow({ category, level, spontaneous = false, force = false }) {
-     if (!force) {
-         if (this._hasScope(QuietScope.ALL)) return false;
-         if (spontaneous && this._hasScope(QuietScope.SPONTANEOUS)) return false;
-     }
+ shouldShow({ category, level, spontaneous = false }) {
+     if (spontaneous && this._quiet.size) return false;
```

`beginQuiet()` perd son argument, `_hasScope()` disparaît, `quietCount` et `clearQuiet()`
sont inchangés. `notify.js` cesse de réexporter `QuietScope` (`notify.js:17`) et
`extension.js` de l'importer (`ext:15`).

Ce qui reste inchangé : `force` n'a jamais contourné le filtre de catégorie (spec n°1
§8.2), donc sa disparition ne rend aucune notification plus bruyante. Décocher
`notify-profile-switch` fait toujours taire « Profile applied ».

---

## 7. Le cycle de vie d'un toggle Feature

`handleFeatureToggled` (`ext:394-460`) se réduit à deux branches symétriques, sans
persistance.

**Recocher** — une notification `network` « `<label>`: enabled », rien d'autre. Le
sous-menu réapparaît en reflétant l'état du daemon.

**Décocher** — une notification `network` « `<label>`: disabled », puis un reset unique du
daemon si l'état courant est non nul, via `withFeedback` :

| Feature | Reset au clic |
|---|---|
| Exit nodes | `setExitNode('')` si `snap.exitNodeID` **ou** `snap.autoExitNode` |
| Magic DNS | `setAcceptDNS(false)` si `snap.acceptDNS` |
| Subnet routes | `setAcceptRoutes(false)` si `snap.acceptRoutes` |
| Shields up | `setShieldsUp(false)` si `snap.shieldsUp` |
| Tailscale SSH | `setRunSSH(false)` si `snap.runSSH` |
| Funnel | `resetFunnels()` si `snap.funnels.length > 0` — aujourd'hui fait par `ensureFeatureCompliance` |
| Taildrop | rien : `syncTaildrop` coupe déjà le receveur |

La condition sur `autoExitNode` reprend la ligne `ext:379-380` que
`ensureFeatureCompliance` portait : sans elle, décocher « Exit nodes » alors que le mode
automatique est actif laisse le routage en place.

**Daemon injoignable au moment du clic** (`!canControl`, `loggedOut`, `backendState` à
`NeedsLogin` ou `NoState`) : une notification `errors` de niveau `warning` — « `<label>`:
not applied (daemon unavailable) » — et rien d'autre. L'UI est masquée quand même. Aucun
drapeau en attente, aucun timer, aucun rattrapage ultérieur : c'est la traduction directe de
« pas de correction de dérive continue ». Une dérive introduite ainsi vaut celle d'une
commande CLI passée derrière l'extension, et se corrige de la même façon — en recliquant.

---

## 8. Migration

Les clés retirées du schéma restent inertes dans dconf chez les utilisateurs qui montent de
version. Aucun code de nettoyage :

- `settings.reset(k)` sur une clé absente du schéma lève ;
- écrire dans dconf à la main pour effacer des valeurs que plus rien ne lit serait du risque
  gratuit dans un fichier de configuration utilisateur.

Après mise à jour, les 7 toggles d'affichage valent ce qu'ils valaient sur le dernier compte
actif — le slot de ce compte ayant été appliqué aux clés vives avant la mise à jour. C'est
un point de départ arbitraire mais cohérent, et l'utilisateur les repositionne une fois.

À noter au CHANGELOG comme un changement de comportement, pas comme un correctif.

---

## 9. Amendements à la spec n°1

| § | Ce qui change |
|---|---|
| §8.2 | La fenêtre de silence du changement de compte est ouverte par l'évènement `account-switched` de `watchers.js`, non par `onSlotLoading`. La notion de portée disparaît : il ne reste qu'une sorte de fenêtre, celle qui ne fait taire que le spontané. « Profil appliqué » perd son `force: true`, devenu redondant avec `spontaneous: false` (§6.4). Le débounce et le plafond dur sont inchangés. |
| §8.3 | `PerAccountFeatureState.isLoadingSlot` et `_suppressSave`, explicitement laissés en place « pour cette spec », disparaissent ici avec leur module. |
| §3.2 | Le handle no-op est inchangé, mais la table du contrat perd `force` : `notify()` accepte `{ category, level, message, gicon, spontaneous }`. |
| §9 | La liste d'évènements de `watchers.js` gagne `account-switched`. |
| §11 | Le test n°11 se renforce : une action utilisateur lancée pendant une bascule doit désormais produire son retour. Les tests 13, 14 et 15 restent valides tels quels. |

---

## 10. Hors périmètre

**Le déplacement des raccourcis clavier dans leur propre page de préférences** est fait
séparément, hors de cette spec : c'est un remaniement d'interface sans rapport avec l'état
par compte.

**Rendre les 7 toggles d'affichage à nouveau configurables par compte** est écarté, pas
reporté. Ce serait réintroduire la brique de mémoire qu'on supprime, pour le seul cas
d'usage d'un utilisateur qui voudrait des menus différents selon son tailnet.

**Aligner l'extension sur les prefs du daemon dans l'autre sens** — lire `tailscale debug
prefs` pour préremplir les toggles d'affichage — n'a pas de sens : les toggles d'affichage
ne correspondent à aucune préférence du daemon, ce sont des choix d'interface.

---

## 11. Vérification

**Automatique**

```
make test
make test-syntax
make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip
```

`make test` gagne une série sur `_accountEvents`, vérifiable sans session GNOME puisque
`watchers.js` n'importe rien de `resource:///org/gnome/shell/` :

| Cas | Attendu |
|---|---|
| démarrage à froid, premier snapshot nommé | aucun évènement |
| `accountName` inchangé | aucun évènement |
| `accountName` vide (déconnecté) | aucun évènement, le tracker ne retient pas le vide |
| `accountName` A → B | un `account-switched`, `data.name === 'B'`, `spontaneous: false` |
| A → B dans le même lot qu'une perte d'exit node | `account-switched` en tête de liste |

Les cinq cas de `tests/notify-policy.test.js` qui exercent `QuietScope.ALL` (`:71,78,86,104`)
sont réécrits sur la fenêtre unique, et un cas est ajouté : sous fenêtre ouverte, une
notification `spontaneous: false` passe — c'est ce qui remplace `force`.

Référence à ne pas dégrader pour `shexli` : **0 erreur, 0 warning**, un seul
`manual_review` (accès presse-papier, déjà déclaré dans `metadata.json`).

**Manuelle, en session imbriquée** (`dbus-run-session -- gnome-shell --devkit`)

| # | Scénario | Attendu |
|---|---|---|
| 1 | basculer perso ↔ pro | l'exit node, Magic DNS et les routes de chaque profil reviennent seuls ; l'extension n'écrit rien |
| 2 | idem | **une seule** notification « Profile applied » |
| 3 | basculer depuis le menu | une seule notification, celle du `withFeedback` — pas de doublon |
| 4 | basculer via `tailscale switch` en ligne de commande | la notification sort quand même |
| 5 | couper `notify-profile-switch`, basculer | silence sur la bascule |
| 6 | cliquer Magic DNS pendant une bascule | le retour de l'action sort (régression volontaire du comportement §8.2) |
| 7 | décocher « Magic DNS » | `CorpDNS` passe à `false`, une notification |
| 8 | recocher « Magic DNS » | le sous-menu réapparaît en affichant `off`, aucune restauration |
| 9 | décocher « Exit nodes » en mode automatique actif | le routage est bien coupé |
| 10 | décocher « Funnel » avec un funnel actif | le funnel est démonté |
| 11 | arrêter `tailscaled`, décocher une feature | warning « not applied », l'UI se masque, rien ne se déclenche au retour du daemon |
| 12 | basculer, daemon lent | le plafond dur referme la fenêtre, les notifications reprennent |
| 13 | désactiver l'extension pendant une bascule | aucun timeout ni source résiduels |

Le point 13 reste celui à ne pas bâcler : c'est la classe de défaut des deux rejets EGO.

**Documentation** — `README.md:26` (« remembers per-tailnet feature preferences ») et
`README.md:152` (l'entrée `per-account.js` de l'arborescence) deviennent faux et doivent
être corrigés dans le même lot.
